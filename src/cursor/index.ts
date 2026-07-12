import { listCdpTargets, connectCdpTarget, type CdpTarget } from "./cdp-client";
import { CursorBridge } from "./bridge";
import { globalEventBus, type SseEvent } from "../web/sse";
import { info, warn, debug } from "../logger";
import { homedir } from "os";
import type { Api } from "grammy";
import { getTopicBySession } from "../topics";
import { addCursorSession, removeSession, getSessions } from "../sessions";
import { scanPortFiles } from "../relay/discovery";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import { TELEGRAM_SAFE_LIMIT } from "../config";
import { getMessageBus } from "../messaging";
import { basename } from "path";

const CURSOR_CDP_PORT = Number(process.env.CURSOR_CDP_PORT ?? 9222);
const SYNC_INTERVAL_MS = 5_000;
const TOPIC_WAIT_MS = 30_000;
const TOPIC_POLL_MS = 1_000;

export interface TelegramForward {
  api: Api;
  chatId: number;
}

interface ActiveBridge {
  bridge: CursorBridge;
  sessionName: string;
}

// Keyed by CDP targetId. One bridge per Cursor window.
const bridges = new Map<string, ActiveBridge>();
const crossPostUnsubs = new Map<string, () => void>();
let syncTimer: Timer | null = null;
let stopped = false;
let running = false;
let telegramForward: TelegramForward | undefined;

/**
 * The single Cursor session whose AI replies are cross-posted to Telegram.
 * `null` = nothing subscribed: bridges still attach to all windows (so they're
 * listable/injectable and topics exist), but no events are forwarded. Set via
 * `setCursorSubscription` (the /cursor list picker) and restored from settings
 * on startup.
 */
let subscribedSession: string | null = null;

/** In-flight CDP sync, so a manual refresh and the timer don't race. */
let syncInFlight: Promise<void> | null = null;

/**
 * Session names of Cursor windows with a currently-connected bridge. This is
 * the authoritative liveness signal for cursor sessions — when a window closes,
 * `syncBridges()` drops its entry — so /cleanzombie can tell a live cursor
 * topic from a stale one without relying on transcript-file existence.
 */
export function getActiveCursorSessionNames(): Set<string> {
  return new Set([...bridges.values()].map((b) => b.sessionName));
}

export function startCursorBridge(opts?: TelegramForward): void {
  telegramForward = opts;
  // Idempotent: a second call (e.g. /cursor re-running while already live)
  // just refreshes the forward target — starting another sync chain would
  // leave two overlapping setTimeout loops running.
  if (running) return;
  running = true;
  stopped = false;
  void syncBridges();
}

export function stopCursorBridge(): void {
  stopped = true;
  running = false;
  // Clearing the subscription is part of "off" — nothing forwards until the
  // user picks a session again from the /cursor list.
  subscribedSession = null;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  for (const unsub of crossPostUnsubs.values()) unsub();
  crossPostUnsubs.clear();
  for (const { bridge, sessionName } of bridges.values()) {
    bridge.stop();
    removeSession(sessionName);
  }
  bridges.clear();
}

/** True when the bridge is attached and polling CDP targets. */
export function isCursorBridgeRunning(): boolean {
  return running;
}

/** Name of the currently-subscribed Cursor session, or null. */
export function getCursorSubscription(): string | null {
  return subscribedSession;
}

/**
 * Set the single Cursor session whose AI replies forward to Telegram (or null
 * to forward nothing). Unwires the cross-post for every other session and
 * wires the new one if its bridge is already attached; otherwise `attachBridge`
 * wires it on the next sync tick once the window connects.
 */
export function setCursorSubscription(sessionName: string | null): void {
  subscribedSession = sessionName;

  // Drop cross-post for any session that is no longer the subscribed one.
  for (const [name, unsub] of crossPostUnsubs) {
    if (name !== sessionName) {
      unsub();
      crossPostUnsubs.delete(name);
    }
  }

  if (!sessionName || !telegramForward) return;
  if (crossPostUnsubs.has(sessionName)) return; // already wired
  const attached = [...bridges.values()].some(
    (b) => b.sessionName === sessionName,
  );
  if (attached) void wireCrossPost(sessionName, telegramForward);
}

/**
 * Run one CDP target sync immediately and await it. Lets the /cursor command
 * populate the session list right after (re)starting the bridge, instead of
 * waiting up to SYNC_INTERVAL_MS for the timer. Reuses the in-flight sync when
 * one is already running so the two paths never mutate `bridges` concurrently.
 */
export async function refreshCursorTargets(): Promise<void> {
  if (stopped) return;
  await runSyncOnce();
}

/**
 * A newly-opened Cursor window briefly reports its title as the raw
 * `vscode-file://...workbench.html` URL until the workspace finishes
 * loading. Attaching during that window mints junk session names like
 * `cursor-vscode-file://vscode-app/applications/cu...` and creates a
 * permanent TG topic for them. Skip attach while the title looks like a
 * URL or is empty — the next sync tick re-evaluates once it settles.
 *
 * Also treats a bare "Cursor" workspace segment as unloaded: when opening
 * a Remote-SSH window, the title shows just "Cursor" until the remote
 * handshake completes. Attaching then produces a "cursor-cursor[-hash]"
 * topic that sticks around even after the workspace name resolves.
 */
export function isUnloadedTitle(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (/^(vscode-file:|https?:|file:|vscode-webview:)/i.test(t)) return true;
  const last =
    t
      .split(/\s[—–-]\s/)
      .pop()
      ?.trim()
      .toLowerCase() ?? "";
  return last === "cursor";
}

/**
 * Page targets that look like Cursor workspace windows. Filters out
 * worker/extension/devtools targets. Cursor's main windows have
 * `vscode-file://` URLs and a webSocketDebuggerUrl.
 */
function isComposerTarget(t: CdpTarget): boolean {
  return (
    t.type === "page" &&
    t.url.startsWith("vscode-file://") &&
    !!t.webSocketDebuggerUrl
  );
}

async function syncBridges(): Promise<void> {
  if (stopped) return;

  await runSyncOnce();

  if (!stopped) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => void syncBridges(), SYNC_INTERVAL_MS);
  }
}

/**
 * One CDP reconciliation pass (no timer scheduling). Guarded so the periodic
 * timer and an explicit `refreshCursorTargets()` share a single in-flight run
 * rather than mutating `bridges` concurrently.
 */
function runSyncOnce(): Promise<void> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    try {
      await reconcileBridges();
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

async function reconcileBridges(): Promise<void> {
  try {
    const targets = await listCdpTargets(CURSOR_CDP_PORT);
    const composerTargets = targets.filter(isComposerTarget);
    const liveIds = new Set(composerTargets.map((t) => t.id));

    // Tear down bridges for closed windows OR for sessions whose CDP
    // WebSocket has died silently. The latter happens when Cursor reloads a
    // renderer, the extension host restarts, or the webview is otherwise
    // recycled — the targetId stays in /json/list, but our WS to it is dead.
    // Without this, the bridge looks attached forever and injections silently
    // no-op. Dropping the entry here lets the "attach new" pass below
    // reconnect with a fresh WebSocket against the same target on the next
    // sync tick.
    //
    // Closed vs dead is asymmetric: a *closed* window is gone, so we remove
    // the session registry entry and unwire crossPost (the topic stays).
    // A *dead-WS reconnect* keeps the session and crossPost in place —
    // tearing those down would make the next attach trigger
    // addCursorSession's "added" callback, which re-runs the topic-manager
    // verification ping (`🟢 <session> online`). On unstable CDP that
    // produced one ping every ~10-20min per session.
    for (const [id, active] of bridges) {
      const closed = !liveIds.has(id);
      const dead = !closed && !active.bridge.isAlive();
      if (!closed && !dead) continue;
      active.bridge.stop();
      bridges.delete(id);
      if (closed) {
        crossPostUnsubs.get(active.sessionName)?.();
        crossPostUnsubs.delete(active.sessionName);
        removeSession(active.sessionName);
        info("cursor-bridge: detached from closed window", {
          session: active.sessionName,
        });
      } else {
        info("cursor-bridge: reconnecting — CDP WebSocket dead", {
          session: active.sessionName,
        });
      }
    }

    // Attach to new windows.
    for (const target of composerTargets) {
      if (bridges.has(target.id)) continue;
      await attachBridge(target);
    }
  } catch (err) {
    debug("cursor-bridge: target sync failed", {
      error: (err as Error).message,
    });
  }
}

async function attachBridge(target: CdpTarget): Promise<void> {
  if (!target.webSocketDebuggerUrl) return;

  // Title hasn't settled yet (still the raw workbench URL). Bail without
  // adding to `bridges` so the next syncBridges tick re-checks once the
  // workspace title loads.
  if (isUnloadedTitle(target.title)) {
    debug("cursor-bridge: skipping attach — title not settled", {
      title: target.title,
    });
    return;
  }

  const sessionName = deriveSessionName(target.title);
  // If another window already produced the same session name (two open
  // tabs in the same workspace), suffix with target id to disambiguate.
  // syncBridges guards `bridges.has(target.id)` before calling here, so the
  // current target is always new — no need to check before disambiguating.
  const finalName = findUniqueName(sessionName, target.id);

  const sessionDir = await resolveCursorSessionDir(target.title);

  try {
    const cdpClient = await connectCdpTarget(target.webSocketDebuggerUrl);
    const bridge = new CursorBridge({
      sessionName: finalName,
      sessionDir,
      cdpClient,
      bus: globalEventBus,
    });
    await bridge.start();
    // Register in the session registry only after start() has fully
    // succeeded. Doing this earlier (e.g. inside bridge.start) would
    // orphan the entry on a partial CDP failure.
    addCursorSession({ name: finalName, dir: sessionDir });
    bridges.set(target.id, { bridge, sessionName: finalName });
    info("cursor-bridge: connected via CDP", { session: finalName });

    // Only forward to Telegram for the subscribed session. Other windows stay
    // attached (listable + injectable) but silent until the user picks them
    // from the /cursor list.
    if (telegramForward && finalName === subscribedSession) {
      void wireCrossPost(finalName, telegramForward);
    }
  } catch (err) {
    warn("cursor-bridge: failed to attach", err, {
      session: finalName,
      title: target.title,
    });
  }
}

/**
 * If `sessionName` is already taken by another bridge, append a short hash
 * of the target id so two windows in the same workspace don't collide.
 */
function findUniqueName(sessionName: string, targetId: string): string {
  const taken = new Set([...bridges.values()].map((b) => b.sessionName));
  if (!taken.has(sessionName)) return sessionName;
  const suffix = targetId.slice(0, 8);
  return `${sessionName}-${suffix}`;
}

/**
 * Wait for the Cursor session's Telegram topic to be created, then
 * subscribe to bus events for the session and forward to the topic.
 *
 * The topicId is resolved on each emit (not captured at subscription
 * time), because topic-manager reconciliation can delete and recreate
 * a topic shortly after the bridge attaches — capturing once would
 * leave the bridge pinned to a deleted thread, and Telegram silently
 * 400s on sendMessage to it.
 */
async function wireCrossPost(
  sessionName: string,
  fwd: TelegramForward,
): Promise<void> {
  const deadline = Date.now() + TOPIC_WAIT_MS;
  while (Date.now() < deadline) {
    if (stopped) return;
    const initialTopic = getTopicBySession(sessionName);
    if (initialTopic) {
      // Window may have closed during the poll — syncBridges cleanup ran
      // before we got here, but couldn't unsub because we hadn't subscribed
      // yet. Re-check ownership here so we don't leak a subscription tied
      // to a detached bridge (bug_004).
      const stillAttached = [...bridges.values()].some(
        (b) => b.sessionName === sessionName,
      );
      if (!stillAttached) return;
      // Avoid duplicate subscriptions on reconnect
      crossPostUnsubs.get(sessionName)?.();
      const unsub = globalEventBus.subscribe(sessionName, (evt: SseEvent) => {
        if (evt.source === "telegram") return; // came from Telegram, don't echo back
        let label: string | null = null;
        if (evt.type === "user_message") {
          label =
            evt.source === "cursor"
              ? "🖱 Cursor"
              : evt.source === "web"
                ? "🌐 Web"
                : "🖥 Terminal";
        } else if (evt.type === "text" && evt.source === "cursor") {
          label = "🤖 Cursor AI";
        }
        if (!label) return;
        // Re-resolve the topic on each emit so we follow topic
        // recreations (topic-manager reconciler can delete+recreate
        // topics shortly after the bridge attaches).
        const currentTopic = getTopicBySession(sessionName);
        if (!currentTopic) return;
        // Render markdown the same way the watch.ts assistant path does,
        // so Cursor AI replies with tables / fenced code / **bold** land
        // in TG with the same formatting as Claude Code replies. Without
        // parse_mode the user sees raw `|` `**` ``` characters (bug_012).
        const labelHtml = `<b>${escapeHtml(label)}:</b>`;
        const bodyHtml = convertMarkdownToHtml(evt.content);
        let html = `${labelHtml}\n${bodyHtml}`;
        if (html.length > TELEGRAM_SAFE_LIMIT) {
          html = html.slice(0, TELEGRAM_SAFE_LIMIT) + "…";
        }
        void getMessageBus()
          .send({
            chatId: fwd.chatId,
            threadId: currentTopic.topicId,
            content: html,
            format: "html",
          })
          .then((res) => {
            if ("dropped" in res) {
              debug("cursor-bridge: cross-post dropped", {
                session: sessionName,
                dropped: res.dropped,
              });
            }
          })
          .catch(() => {});
      });
      crossPostUnsubs.set(sessionName, unsub);
      info("cursor-bridge: cross-post wired", {
        session: sessionName,
        topic: initialTopic.topicId,
      });
      return;
    }
    await new Promise((r) => setTimeout(r, TOPIC_POLL_MS));
  }
  warn("cursor-bridge: topic not created", undefined, {
    session: sessionName,
    waitedMs: TOPIC_WAIT_MS,
  });
}

/**
 * Cursor's main page title is "<file-or-version> — <workspace-name>", e.g.
 * "2.1.132 — claude-mobile-bridge" or "compose.local.env — kinetix-cloud".
 * Extract the workspace name (last segment); fall back to a slug of the
 * full title.
 */
function deriveSessionName(title: string): string {
  // Reuse extractWorkspaceName so the generated name matches what directory
  // resolution sees — it drops the trailing " [SSH: …]"/" [WSL: …]" tag Cursor
  // appends to remote windows (otherwise the name keeps an ugly bracket
  // fragment while dir matching resolves cleanly).
  const candidate = extractWorkspaceName(title).slice(0, 40);
  return candidate ? `cursor-${candidate}` : "cursor-ide";
}

/**
 * Cursor's CDP /json/list doesn't expose the workspace fsPath — only a window
 * title and the workbench-app URL. Fall back to looking at the workspace name
 * the title carries (the segment after " — ") and matching it against the
 * basename of known project directories: live claude-code relay processes
 * (scanPortFiles), and any session the bot already tracks (getSessions).
 *
 * Returns the matching directory when exactly one is found, otherwise homedir()
 * — same default the bridge had before. The single-match rule avoids guessing
 * when two unrelated projects happen to share a basename.
 */
async function resolveCursorSessionDir(title: string): Promise<string> {
  const candidates = new Set<string>();
  try {
    const portFiles = await scanPortFiles();
    for (const pf of portFiles) if (pf.cwd) candidates.add(pf.cwd);
  } catch {
    // scanPortFiles is best-effort here — fall through to getSessions.
  }
  try {
    for (const s of getSessions()) if (s.dir) candidates.add(s.dir);
  } catch {
    // Same.
  }
  return matchWorkspaceDir(title, candidates) ?? homedir();
}

/**
 * Pure helper: pick the directory whose basename matches the workspace name
 * carried in a Cursor window title. Returns the dir on a unique match, or
 * null when there's no match or it's ambiguous (the caller falls back to
 * homedir — better than guessing).
 *
 * Exported for testability.
 */
export function matchWorkspaceDir(
  title: string,
  knownDirs: Iterable<string>,
): string | null {
  const target = extractWorkspaceName(title);
  if (!target) return null;
  const matches = [...knownDirs].filter(
    (dir) => normaliseName(basename(dir)) === target,
  );
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Extract the workspace-name portion of a Cursor window title.
 * "2.1.141 — claude-mobile-bridge" → "claude-mobile-bridge"
 * "build_newpod.sh — Monkey_OCR [SSH: …]" → "monkey_ocr"  (drops the [SSH] tag)
 */
export function extractWorkspaceName(title: string): string {
  const dashSplit = title.split(/\s[—–-]\s/);
  const last = dashSplit[dashSplit.length - 1] ?? title;
  // Strip a trailing " [SSH: …]" / " [WSL: …]" suffix Cursor appends to remotes.
  const stripped = last.replace(/\s*\[[^\]]+\]\s*$/, "");
  return normaliseName(stripped.trim());
}

/** Lowercase + collapse whitespace so title basenames and dir basenames match. */
function normaliseName(s: string): string {
  return s.replace(/\s+/g, "-").toLowerCase();
}
