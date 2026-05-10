import { listCdpTargets, connectCdpTarget, type CdpTarget } from "./cdp-client";
import { CursorBridge } from "./bridge";
import { globalEventBus, type SseEvent } from "../web/sse";
import { info, warn } from "../logger";
import { homedir } from "os";
import type { Api } from "grammy";
import { getTopicBySession } from "../topics";
import { addCursorSession, removeSession } from "../sessions";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import { TELEGRAM_SAFE_LIMIT } from "../config";

const CURSOR_CDP_PORT = Number(process.env.CURSOR_CDP_PORT ?? 9222);
const SYNC_INTERVAL_MS = 5_000;
const TOPIC_WAIT_MS = 30_000;
const TOPIC_POLL_MS = 1_000;

interface TelegramForward {
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
let telegramForward: TelegramForward | undefined;

export function startCursorBridge(opts?: TelegramForward): void {
  stopped = false;
  telegramForward = opts;
  void syncBridges();
}

export function stopCursorBridge(): void {
  stopped = true;
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

  try {
    const targets = await listCdpTargets(CURSOR_CDP_PORT);
    const composerTargets = targets.filter(isComposerTarget);
    const liveIds = new Set(composerTargets.map((t) => t.id));

    // Tear down bridges for closed windows.
    for (const [id, active] of bridges) {
      if (!liveIds.has(id)) {
        active.bridge.stop();
        crossPostUnsubs.get(active.sessionName)?.();
        crossPostUnsubs.delete(active.sessionName);
        removeSession(active.sessionName);
        bridges.delete(id);
        info(
          `cursor-bridge: detached from closed window "${active.sessionName}"`,
        );
      }
    }

    // Attach to new windows.
    for (const target of composerTargets) {
      if (bridges.has(target.id)) continue;
      await attachBridge(target);
    }
  } catch (err) {
    warn(`cursor-bridge: target sync failed: ${(err as Error).message}`);
  }

  if (!stopped) {
    syncTimer = setTimeout(() => void syncBridges(), SYNC_INTERVAL_MS);
  }
}

async function attachBridge(target: CdpTarget): Promise<void> {
  if (!target.webSocketDebuggerUrl) return;

  const sessionName = deriveSessionName(target.title);
  // If another window already produced the same session name (two open
  // tabs in the same workspace), suffix with target id to disambiguate.
  // syncBridges guards `bridges.has(target.id)` before calling here, so the
  // current target is always new — no need to check before disambiguating.
  const finalName = findUniqueName(sessionName, target.id);

  const sessionDir = homedir();

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
    info(`cursor-bridge: connected to "${finalName}" via CDP`);

    if (telegramForward) {
      void wireCrossPost(finalName, telegramForward);
    }
  } catch (err) {
    warn(
      `cursor-bridge: failed to attach to "${target.title}": ${(err as Error).message}`,
    );
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
        fwd.api
          .sendMessage(fwd.chatId, html, {
            parse_mode: "HTML",
            message_thread_id: currentTopic.topicId,
          })
          .catch(() => {});
      });
      crossPostUnsubs.set(sessionName, unsub);
      info(
        `cursor-bridge: cross-post wired for "${sessionName}" → topic ${initialTopic.topicId}`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, TOPIC_POLL_MS));
  }
  warn(
    `cursor-bridge: topic not created within ${TOPIC_WAIT_MS}ms for "${sessionName}"`,
  );
}

/**
 * Cursor's main page title is "<file-or-version> — <workspace-name>", e.g.
 * "2.1.132 — claude-mobile-bridge" or "compose.local.env — kinetix-cloud".
 * Extract the workspace name (last segment); fall back to a slug of the
 * full title.
 */
function deriveSessionName(title: string): string {
  const dashSplit = title.split(/\s[—–-]\s/);
  const last = dashSplit[dashSplit.length - 1] ?? title;
  const candidate = last.trim().slice(0, 40).replace(/\s+/g, "-").toLowerCase();
  return candidate ? `cursor-${candidate}` : "cursor-ide";
}
