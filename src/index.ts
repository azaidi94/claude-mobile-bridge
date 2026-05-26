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
import { startCursorBridge, stopCursorBridge } from "./cursor";
import { TELEGRAM_TOKEN, ALLOWED_USERS, RESTART_FILE } from "./config";
import { getWorkingDir } from "./settings";
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
  getThreadId,
  getTopicStore,
  backfillLedgerFromStore,
  TopicManager,
} from "./topics";
import { createBot } from "./bot";
import { getCurrentModelDisplayName } from "./session";
import { getRelayClient, invalidateScanCache, scanPortFiles } from "./relay";
import { backfillPortFileSessionIds } from "./relay/backfill";
import { info, warn, error as logError } from "./logger";
import pkg from "../package.json";
import { startWebServer } from "./web/server";
import { WEB_ENABLED } from "./config";
import { initRelayAsk } from "./handlers/relay-ask";
import { setBotApiForBridge } from "./handlers/auq-bridge";

let topicManager: TopicManager | undefined;

// Create bot instance using factory
const bot = createBot({
  token: TELEGRAM_TOKEN,
  onForumGroupDetected: (chatId) => {
    info(`bot: detected forum group ${chatId}, adopting for topics`);
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

info(
  `cwd: ${getWorkingDir()} (${ALLOWED_USERS.length} user${ALLOWED_USERS.length !== 1 ? "s" : ""})`,
);

// Load persisted chat IDs and pinned message IDs
await loadChatIds();
await loadPinnedMessageIds();
await loadTopicStore();

// Backfill the topic ledger from the store on startup, so any mapping
// that pre-dates the ledger is visible to /cleanzombie's liveness pass.
// Idempotent — already-recorded topic ids are skipped.
try {
  const added = await backfillLedgerFromStore(getTopicStore().topics);
  if (added > 0) info(`topic-ledger: backfilled ${added} pre-ledger topic(s)`);
} catch (err) {
  warn(`topic-ledger: backfill failed: ${err}`);
}

// Wire up pinned-status updates on plan-mode change. Each newly created
// SessionState gets a globalEventBus subscriber that updates the pin for
// that session's topic. The hook is registered before any handler runs,
// so the first time getSessionState(name) is called for a session, this
// closure subscribes and stays attached for the process lifetime.
setOnSessionStateCreated((state) => {
  const sessionName = state.sessionName;
  if (!sessionName) return;
  globalEventBus.subscribe(sessionName, (evt) => {
    if (evt.type !== "mode_change") return;
    const info = getSession(sessionName);
    const topicId = getThreadId(sessionName);
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
});

// Wire up watch handler's offline callback for resume flow
setSessionOfflineCallback(notifySessionOffline);
// Kill-suppressed removals still need to tear down any orphan watch so
// drift detection isn't muted on the surviving sibling.
setSessionCleanupCallback((sessionName) => {
  stopWatchByName(sessionName, undefined, "session-gone");
});

const botInfo = await bot.api.getMe();
info(`bot: @${botInfo.username} ready`);

// Wire the ask_remote round-trip glue. After this call, every relay client
// the bot connects to (now or later) auto-subscribes to ask_remote_request
// frames and posts the question to TG with an inline keyboard.
initRelayAsk(bot.api);
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
    warn(`flush reconnect summaries failed: ${err}`),
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
  const tm = topicManager;
  if (!tm) return;
  const chatId = tm.getChatId();
  if (chatId === undefined) return;
  for (const s of getSessions()) {
    const topic = getTopicBySession(s.name);
    if (!topic) continue;
    if (isWatching(chatId, topic.topicId)) continue;
    startAutoWatch(bot.api, chatId, topic.topicId, s.name).catch((err) =>
      warn(
        `auto-watch retry failed for ${s.name} (topic ${topic.topicId}): ${err}`,
      ),
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
  topicId: number,
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
        warn(`relay ping iteration error for ${sessionName}: ${err}`);
      }
    }
    warn(`relay ping failed after retries for ${sessionName}`);
  })().catch((err) => warn(`relay ping error for ${sessionName}: ${err}`));
}

const notifyHandler = createNotificationHandler(
  bot.api,
  topicManager,
  (sessionName, topicId, sessionDir, sessionId, claudePid) => {
    const chatId = topicManager?.getChatId();
    if (chatId !== undefined && topicId !== undefined) {
      pingRelayForSession(
        sessionName,
        topicId,
        sessionDir,
        chatId,
        sessionId,
        claudePid,
      );
      startAutoWatch(bot.api, chatId, topicId, sessionName).catch((err) =>
        warn(
          `auto-watch on-notify failed for ${sessionName} (topic ${topicId}): ${err}`,
        ),
      );
    }
  },
);
await startWatcher(notifyHandler);

// Backfill sessionId on any existing relay port files that lack it (relay
// processes started before the discovery-loop race fix, or any with a still-
// undiscovered JSONL at startup). Runs once, idempotent.
await backfillPortFileSessionIds();

// Cursor integration is opt-out. Set CURSOR_BRIDGE_ENABLED=false (or
// 0/no/off) to skip CDP target polling — useful when Cursor isn't
// running or the user only wants the Claude Code bridge.
const cursorBridgeEnabled = !["false", "0", "no", "off"].includes(
  (process.env.CURSOR_BRIDGE_ENABLED ?? "").toLowerCase(),
);
if (cursorBridgeEnabled) {
  startCursorBridge(
    primaryChatId !== undefined
      ? { api: bot.api, chatId: primaryChatId }
      : undefined,
  );
} else {
  info("cursor-bridge: disabled via CURSOR_BRIDGE_ENABLED");
}

if (topicManager && primaryChatId !== undefined) {
  const sessions = getSessions();
  await topicManager.reconcile(
    sessions.map((s) => ({ name: s.name, dir: s.dir, id: s.id })),
  );

  // Start auto-watch and ping relay for all online sessions with topics
  for (const s of sessions) {
    const topic = getTopicBySession(s.name);
    if (topic) {
      pingRelayForSession(
        s.name,
        topic.topicId,
        s.dir,
        primaryChatId,
        s.id,
        s.pid,
      );
      startAutoWatch(bot.api, primaryChatId, topic.topicId, s.name).catch(
        (err) =>
          warn(
            `auto-watch startup failed for ${s.name} (topic ${topic.topicId}): ${err}`,
          ),
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
  { command: "stop", description: "Interrupt current query" },
  { command: "kill", description: "Terminate session" },
  { command: "retry", description: "Retry last message" },
  { command: "status", description: "Show session details" },
  { command: "model", description: "Show/switch model" },
  { command: "usage", description: "Claude Code quota stats" },
  { command: "execute", description: "Start/stop configured scripts" },
  { command: "settings", description: "Persistent settings panel" },
  { command: "groupmode", description: "Toggle group vs private routing" },
  { command: "cleanzombie", description: "Delete stale forum topics" },
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
    warn(`restart msg: ${e}`);
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
  monitored
    .task()
    ?.then(() => {
      if (stopping || monitored !== runner) return;
      warn("runner stopped unexpectedly, restarting in 3s");
      setTimeout(() => {
        runner = run(bot);
        monitorRunner();
      }, 3000);
    })
    .catch((err) => {
      if (stopping || monitored !== runner) return;
      warn(`runner error: ${err}, restarting in 3s`);
      setTimeout(() => {
        runner = run(bot);
        monitorRunner();
      }, 3000);
    });
}
monitorRunner();

// Graceful shutdown
const stopRunner = () => {
  if (runner.isRunning()) {
    stopping = true;
    info("stopping bot");
    stopWatchdog();
    clearInterval(autoWatchRetryTimer);
    stopWatcher();
    stopCursorBridge();
    runner.stop();
  }
};

process.on("uncaughtException", (err) => {
  logError("process: uncaught exception", err);
  stopRunner();
  process.exit(1);
});

process.on("SIGINT", () => {
  info("SIGINT");
  stopRunner();
  process.exit(0);
});

process.on("SIGTERM", () => {
  info("SIGTERM");
  stopRunner();
  process.exit(0);
});
