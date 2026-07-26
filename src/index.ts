/**
 * Claude Coding Bot
 *
 * Multi-session Claude Code control via Telegram.
 */

import { setupBotLogRotation } from "./log-rotation";
import { homedir } from "os";
import { join } from "path";
setupBotLogRotation(
  join(homedir(), "Library", "Logs", "claude-mobile-bridge", "bot.log"),
);

import { run } from "@grammyjs/runner";
import {
  startCursorBridge,
  stopCursorBridge,
  setCursorSubscription,
} from "./cursor";
import { TELEGRAM_TOKEN, ALLOWED_USERS, RESTART_FILE } from "./config";
import {
  getWorkingDir,
  getAutoWatchOnSpawn,
  getCursorEnabled,
  getCursorSubscribedSession,
} from "./settings";
import { setRestartFn } from "./lifecycle";
import { unlinkSync, readFileSync, existsSync } from "fs";
import {
  startWatcher,
  stopWatcher,
  loadChatIds,
  loadPinnedMessageIds,
  getChatIds,
  updatePinnedStatus,
  createNotificationHandler,
  setSessionOfflineCallback,
  setSessionCleanupCallback,
  getGitBranch,
  getSessions,
  setOnSessionStateCreated,
  getSession,
} from "./sessions";
import { globalEventBus } from "./web/sse";
import {
  isWatching,
  notifySessionOffline,
  setTopicManager,
  startAutoWatch,
  startWatchdog,
  stopWatchByName,
  stopWatchdog,
  flushBridgeReconnectSummaries,
} from "./handlers";
import { onBridgeChange } from "./bridge-health";
import {
  loadTopicStore,
  setChatId,
  getTopicBySession,
  getTopicStore,
  backfillLedgerFromStore,
  TopicManager,
} from "./topics";
import { topicForSession } from "./topics/topic-store";
import { launchUuidForPid } from "./sessions/resolve-session";
import { createBot } from "./bot";
import { getCurrentModelDisplayName } from "./session";
import { getRelayClient, invalidateScanCache, scanPortFiles } from "./relay";
import { info, warn, debug, error as logError } from "./logger";
import pkg from "../package.json";
import { startWebServer } from "./web/server";
import { WEB_ENABLED } from "./config";
import { initRelayAsk } from "./handlers/relay-ask";
import { initPermissionRelay } from "./handlers/permission-relay";
import { setBotApiForBridge } from "./handlers/auq-bridge";
import { startModalWatchdog } from "./tmux/watchdog";

let topicManager: TopicManager | undefined;

// Create bot instance using factory
const bot = createBot({
  token: TELEGRAM_TOKEN,
  onForumGroupDetected: (chatId) => {
    info("bot: detected forum group, adopting for topics", { chatId });
    setChatId(chatId);
    if (!topicManager) {
      topicManager = new TopicManager(bot.api, chatId);
      setTopicManager(topicManager);
    } else {
      topicManager.setChatId(chatId);
    }
  },
});

process.on("warning", (warning) => {
  warn("process: warning", warning);
});

process.on("unhandledRejection", (reason) => {
  logError("process: unhandled rejection", reason);
});

// ============== Startup ==============

info("startup: cwd", {
  cwd: getWorkingDir(),
  users: ALLOWED_USERS.length,
});

// Load persisted chat IDs and pinned message IDs
await loadChatIds();
await loadPinnedMessageIds();
await loadTopicStore();

// Backfill the topic ledger from the store on startup, so any mapping
// that pre-dates the ledger is visible to /cleanzombie's liveness pass.
// Idempotent — already-recorded topic ids are skipped.
try {
  const added = await backfillLedgerFromStore(getTopicStore().topics);
  if (added > 0) info("topic-ledger: backfilled pre-ledger topics", { added });
} catch (err) {
  warn("topic-ledger: backfill failed", err);
}

// Wire up pinned-status updates on plan-mode change. Each newly created
// SessionState gets a globalEventBus subscriber that updates the pin for
// that session's topic. The hook is registered before any handler runs, so
// the first time getSessionState(name) is called for a session, this closure
// subscribes. The unsubscribe is registered as a state cleanup so a
// kill→recreate of the same session name detaches the old subscriber instead
// of stacking a duplicate.
setOnSessionStateCreated((state) => {
  const sessionName = state.sessionName;
  if (!sessionName) return;
  const unsub = globalEventBus.subscribe(sessionName, (evt) => {
    if (evt.type !== "mode_change") return;
    const info = getSession(sessionName);
    const topicId = topicForSession({
      launchUuid: launchUuidForPid(info?.pid),
      sessionName,
    })?.topicId;
    const dir = info?.dir ?? state.workingDir;
    getGitBranch(dir)
      .then((branch) => {
        const status = {
          sessionName,
          isPlanMode: !!evt.isPlanMode,
          model: getCurrentModelDisplayName(),
          branch,
        };
        for (const chatId of getChatIds()) {
          updatePinnedStatus(bot.api, chatId, status, topicId).catch(() => {});
        }
      })
      .catch(() => {});
  });
  state.registerCleanup(unsub);
});

// Wire up watch handler's offline callback for resume flow
setSessionOfflineCallback(notifySessionOffline);
// Kill-suppressed removals still need to tear down any orphan watch so
// drift detection isn't muted on the surviving sibling.
setSessionCleanupCallback((sessionName) => {
  stopWatchByName(sessionName, undefined, "session-gone");
});

const botInfo = await bot.api.getMe();
info("bot: ready", { username: botInfo.username });

// Wire the ask_remote round-trip glue. After this call, every relay client
// the bot connects to (now or later) auto-subscribes to ask_remote_request
// frames and posts the question to TG with an inline keyboard.
initRelayAsk(bot.api);
// Same deal for permission prompts: any relay the bot connects to mirrors its
// tool-approval dialogs into the session's topic.
initPermissionRelay(bot.api);
setBotApiForBridge(bot.api);
if (WEB_ENABLED) {
  startWebServer();
}

// Watchdog scans active watches for mid-turn idle and pings the topic
// (or auto-sends "continue" when WATCHDOG_AUTO_CONTINUE is set).
startWatchdog(bot.api);

// On TG reconnect, emit one "skipped N events" summary per affected watch
// instead of replaying the backlog one-by-one through grammy's send queue.
onBridgeChange((online) => {
  if (!online) return;
  flushBridgeReconnectSummaries(bot.api).catch((err) =>
    warn("flush reconnect summaries failed", err),
  );
});

// Periodic retry for topics whose startup auto-watch failed (e.g. session
// briefly invisible to scanSessions when the bot booted). Skip topics that
// already have an active watch — startAutoWatch's same-session conflict
// path tears down the existing watch via `auto-replace` and rebuilds it,
// so calling it on every tick for healthy watches thrashes the JSONL
// tailer and emits noisy `watch: stopped` logs.
const AUTO_WATCH_RETRY_MS = 60_000;
const autoWatchRetryTimer: Timer = setInterval(() => {
  // Respect the autoWatchOnSpawn setting here too — previously this loop
  // re-watched every topic unconditionally, so disabling the setting in the
  // /new spawn path never fully took effect (this loop re-armed the watch
  // within 60s). Both paths now honour the same toggle.
  if (!getAutoWatchOnSpawn()) return;
  const tm = topicManager;
  if (!tm) return;
  const chatId = tm.getChatId();
  if (chatId === undefined) return;
  for (const s of getSessions()) {
    const topic = getTopicBySession(s.name);
    if (!topic) continue;
    if (isWatching(chatId, topic.topicId)) continue;
    startAutoWatch(bot.api, chatId, topic.topicId, s.name).catch((err) =>
      debug("auto-watch retry failed", {
        session: s.name,
        topic: topic.topicId,
        err: String(err),
      }),
    );
  }
}, AUTO_WATCH_RETRY_MS);

const chatIdSet = getChatIds();
// Prefer the stored topic chat ID (may be a group), fall back to first registered chat
const storedTopicChatId = getTopicStore().chatId;
const primaryChatId =
  storedTopicChatId || ([...chatIdSet][0] as number | undefined);
if (primaryChatId !== undefined && storedTopicChatId) {
  setChatId(primaryChatId);
  topicManager = new TopicManager(bot.api, primaryChatId);
  setTopicManager(topicManager);
}

/**
 * Force a freshly-spawned Claude session to write its JSONL by sending a
 * relay message; exits as soon as the port file has a sessionId. The text is
 * visible to Claude — the relay has no out-of-band wake channel — but the
 * MCP `instructions` direct it to use the `reply` tool, not echo terminal.
 *
 * Skipped entirely when sessionId is already known (caller saw the JSONL),
 * since the only purpose of the ping is to learn it. Pinging anyway flooded
 * resumed sessions with `Session Name:` text the user could see.
 */
function pingRelayForSession(
  sessionName: string,
  sessionDir: string,
  chatId: number,
  sessionId?: string,
  claudePid?: number,
): void {
  if (sessionId) return;
  (async () => {
    const RETRY_DELAYS_MS = [3_000, 5_000, 7_000, 10_000, 15_000];
    for (const delay of RETRY_DELAYS_MS) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        invalidateScanCache();
        const ports = await scanPortFiles();
        // Prefer exact match: claudePid > sessionName written to port file > sessionId.
        // claudePid may be undefined when the session was detected before its relay
        // wrote the port file; sessionName is written by the bot during createTopic,
        // so it's always available by the time we retry.
        const relayPort =
          ports.find(
            (pf) => claudePid !== undefined && pf.ppid === claudePid,
          ) ??
          ports.find((pf) => pf.sessionName === sessionName) ??
          ports.find((pf) => pf.sessionId && pf.sessionId === sessionId);
        if (relayPort?.sessionId) return; // relay found its JSONL, done
        const resolvedPid = relayPort?.ppid ?? claudePid;
        const client = await getRelayClient({
          sessionId: relayPort?.sessionId ?? sessionId,
          sessionDir,
          claudePid: resolvedPid,
        });
        client?.sendMessage({
          chat_id: String(chatId),
          user: "bridge",
          text: `Session Name: ${sessionName}`,
        });
      } catch (err) {
        debug("relay ping iteration error", {
          session: sessionName,
          err: String(err),
        });
      }
    }
    warn("relay ping failed after retries", { session: sessionName });
  })().catch((err) => warn("relay ping error", err, { session: sessionName }));
}

const notifyHandler = createNotificationHandler(
  bot.api,
  // Getter, not the value: topicManager may still be undefined here on a fresh
  // install (it's created later by onForumGroupDetected). Resolving per-event
  // means notifications start creating topics as soon as the manager exists,
  // without a restart.
  () => topicManager,
  (sessionName, topicId, sessionDir, sessionId, claudePid) => {
    const chatId = topicManager?.getChatId();
    if (chatId !== undefined && topicId !== undefined) {
      pingRelayForSession(
        sessionName,
        sessionDir,
        chatId,
        sessionId,
        claudePid,
      );
      startAutoWatch(bot.api, chatId, topicId, sessionName).catch((err) =>
        warn("auto-watch on-notify failed", err, {
          session: sessionName,
          topic: topicId,
        }),
      );
    }
  },
);
// sessionId backfill for id-less port files now runs inside the watcher's
// refresh cycle (see doRefresh), so it covers both startup and any session
// that appears later — no separate startup sweep needed here.
await startWatcher(notifyHandler);
// Stopped in stopRunner: an orphaned tick would keep polling tmux and posting
// into a torn-down topic store.
const stopModalWatchdog = startModalWatchdog();

// Cursor integration is opt-out. Disabled if CURSOR_BRIDGE_ENABLED env var
// is false/0/no/off, OR if the user has toggled it off via /cursor off.
const envDisabled = ["false", "0", "no", "off"].includes(
  (process.env.CURSOR_BRIDGE_ENABLED ?? "").toLowerCase(),
);
const cursorBridgeEnabled = !envDisabled && getCursorEnabled();
if (cursorBridgeEnabled) {
  startCursorBridge(
    primaryChatId !== undefined
      ? { api: bot.api, chatId: primaryChatId }
      : undefined,
  );
  // Restore the persisted single-session subscription so forwarding resumes
  // once that window re-attaches. Undefined → nothing forwarded until picked.
  setCursorSubscription(getCursorSubscribedSession() ?? null);
} else {
  info("cursor-bridge: disabled via CURSOR_BRIDGE_ENABLED");
}

// Cron scheduler runs only when we know which chat to send results to;
// otherwise a fired job has no destination.
let stopCronSchedulerFn: (() => void) | undefined;
if (primaryChatId !== undefined) {
  const { startCronScheduler, stopCronScheduler } =
    await import("./cron/scheduler");
  stopCronSchedulerFn = stopCronScheduler;
  startCronScheduler(bot.api, primaryChatId);
}

// Recover any active ralph loop: resume monitoring a live one, or finalize one
// that ended while the bridge was offline. Hydrates the store's sync cache
// (used by the text-handler output-only guard) as a side effect.
try {
  const { recoverRalphOnBoot } = await import("./ralph/monitor");
  await recoverRalphOnBoot(bot.api);
} catch (err) {
  warn("ralph: boot recovery failed", err);
}

if (topicManager && primaryChatId !== undefined) {
  const sessions = getSessions();
  // Don't reconcile (create topics for) cursor sessions other than the
  // subscribed one — cursor topics are created on demand via /cursor. The
  // subscribed one is kept so its existing topic is re-validated on restart.
  const subscribedCursor = getCursorSubscribedSession();
  await topicManager.reconcile(
    sessions
      .filter((s) => s.source !== "cursor" || s.name === subscribedCursor)
      .map((s) => ({ name: s.name, dir: s.dir, id: s.id })),
  );

  // Start auto-watch and ping relay for all online sessions with topics
  for (const s of sessions) {
    const topic = getTopicBySession(s.name);
    if (topic) {
      pingRelayForSession(s.name, s.dir, primaryChatId, s.id, s.pid);
      startAutoWatch(bot.api, primaryChatId, topic.topicId, s.name).catch(
        (err) =>
          warn("auto-watch startup failed", err, {
            session: s.name,
            topic: topic.topicId,
          }),
      );
    }
  }
}

// Set autocomplete commands
await bot.api.setMyCommands([
  { command: "list", description: "Show all sessions" },
  { command: "sessions", description: "Browse offline sessions" },
  { command: "new", description: "Open desktop Claude (Terminal)" },
  { command: "run", description: "Async — fire prompt, ping when done" },
  { command: "stop", description: "Stop query + clear pending prompts" },
  { command: "interrupt", description: "Stop query, keep pending prompts" },
  { command: "kill", description: "Terminate session" },
  { command: "retry", description: "Retry last message" },
  { command: "status", description: "Show session details" },
  { command: "model", description: "Show/switch model" },
  { command: "usage", description: "Claude Code quota stats" },
  { command: "execute", description: "Start/stop configured scripts" },
  { command: "settings", description: "Persistent settings panel" },
  {
    command: "verbose",
    description: "Stream verbosity: 0 quiet, 1, 2 detailed",
  },
  { command: "groupmode", description: "Toggle group vs private routing" },
  { command: "cursor", description: "Enable or disable Cursor AI bridge" },
  { command: "cleanzombie", description: "Delete stale forum topics" },
  { command: "cron", description: "Schedule prompts at cron times" },
  { command: "ralph", description: "Run a ralph loop (afk_tasks.sh)" },
  { command: "prompts", description: "Tappable saved-prompt menu" },
  { command: "skills", description: "Browse & run Claude skills/commands" },
  { command: "clear", description: "Send /clear to the desktop session" },
  { command: "compact", description: "Send /compact to the desktop session" },
  { command: "context", description: "Send /context to the desktop session" },
  { command: "tmux", description: "Session panel — peek · kill · start" },
  { command: "peek", description: "Snapshot a session's live terminal screen" },
  { command: "help", description: "Show commands" },
  { command: "restart", description: "Restart bot" },
]);

// Check for pending restart message
if (existsSync(RESTART_FILE)) {
  try {
    const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
    const age = Date.now() - data.timestamp;

    if (age < 30000 && data.chat_id && data.message_id) {
      await bot.api.editMessageText(
        data.chat_id,
        data.message_id,
        "✅ Restarted",
      );
    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    warn("restart msg failed", e);
    try {
      unlinkSync(RESTART_FILE);
    } catch {
      // silently ok: best-effort cleanup of restart marker
    }
  }
}

// Start bot with auto-restart on unexpected stops (e.g. laptop sleep timeout)
let stopping = false;
let runner = run(bot);

function restartRunner() {
  info("restarting runner");
  runner.stop();
  runner = run(bot);
  monitorRunner();
  info("runner restarted");
}

setRestartFn(restartRunner);

function monitorRunner() {
  const monitored = runner;
  // Re-check guards at FIRE time, not just when scheduling: a /restart (or a
  // shutdown) arriving during the 3s window already swapped `runner`, and an
  // unconditional restart here would start a second concurrent getUpdates
  // poller → Telegram 409 conflicts.
  const scheduleRestart = (reason: string) => {
    if (stopping || monitored !== runner) return;
    warn("runner restarting in 3s", { reason });
    setTimeout(() => {
      if (stopping || monitored !== runner) return;
      runner = run(bot);
      monitorRunner();
    }, 3000);
  };
  monitored
    .task()
    ?.then(() => scheduleRestart("runner stopped unexpectedly"))
    .catch((err) => scheduleRestart(`runner error: ${err}`));
}
monitorRunner();

// Graceful shutdown
const stopRunner = () => {
  // Set stopping unconditionally — a runner that died into the 3s restart
  // window is not isRunning(), and without this the pending restart timer
  // would resurrect it after we asked to stop.
  stopping = true;
  if (runner.isRunning()) {
    info("stopping bot");
    stopCronSchedulerFn?.();
    stopWatchdog();
    stopModalWatchdog();
    clearInterval(autoWatchRetryTimer);
    stopWatcher();
    stopCursorBridge();
    import("./ralph/monitor").then((m) => m.stopRalphMonitor()).catch(() => {});
    runner.stop();
  }
};

/** Best-effort flush of cron + prompt stores before shutdown. */
async function flushStores(): Promise<void> {
  try {
    const [
      { flush: flushCron },
      { flush: flushPrompts },
      { flush: flushRalph },
      { flush: flushSkillRecents },
    ] = await Promise.all([
      import("./cron/store"),
      import("./prompts/store"),
      import("./ralph/store"),
      import("./skills/recents"),
    ]);
    await Promise.all([
      flushCron(),
      flushPrompts(),
      flushRalph(),
      flushSkillRecents(),
    ]);
  } catch (err) {
    warn("shutdown flush failed", err);
  }
}

process.on("uncaughtException", (err) => {
  logError("process: uncaught exception", err);
  stopRunner();
  flushStores().finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 2_000);
});

process.on("SIGINT", () => {
  info("SIGINT");
  stopRunner();
  flushStores().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000);
});

process.on("SIGTERM", () => {
  info("SIGTERM");
  stopRunner();
  flushStores().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000);
});
