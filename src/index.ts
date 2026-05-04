/**
 * Claude Coding Bot
 *
 * Multi-session Claude Code control via Telegram.
 */

import { run } from "@grammyjs/runner";
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
  getActiveSession,
  getGitBranch,
  getSessions,
} from "./sessions";
import {
  isWatching,
  notifySessionOffline,
  setTopicManager,
  startAutoWatch,
  startWatchdog,
  stopWatchByName,
  stopWatchdog,
} from "./handlers";
import {
  loadTopicStore,
  setChatId,
  getTopicBySession,
  getThreadId,
  TopicManager,
} from "./topics";
import { createBot } from "./bot";
import { session } from "./session";
import { getRelayClient } from "./relay";
import { info, warn, error as logError } from "./logger";
import pkg from "../package.json";
import { startWebServer } from "./web/server";
import { WEB_ENABLED } from "./config";

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

// Wire up mode change callback to update pinned status
session.onModeChange = (isPlanMode) => {
  const active = getActiveSession();
  const topicId = active ? getThreadId(active.name) : undefined;
  getGitBranch(session.workingDir)
    .then((branch) => {
      const status = {
        sessionName: active?.name || null,
        isPlanMode,
        model: session.modelDisplayName,
        branch,
      };
      for (const chatId of getChatIds()) {
        updatePinnedStatus(bot.api, chatId, status, topicId).catch(() => {});
      }
    })
    .catch(() => {});
};

// Wire up watch handler's offline callback for resume flow
setSessionOfflineCallback(notifySessionOffline);
// Kill-suppressed removals still need to tear down any orphan watch so
// drift detection isn't muted on the surviving sibling.
setSessionCleanupCallback((sessionName) => {
  stopWatchByName(sessionName, undefined, "session-gone");
});

const botInfo = await bot.api.getMe();
info(`bot: @${botInfo.username} ready`);
if (WEB_ENABLED) {
  startWebServer();
}

// Watchdog scans active watches for mid-turn idle and pings the topic
// (or auto-sends "continue" when WATCHDOG_AUTO_CONTINUE is set).
startWatchdog(bot.api);

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
import { getTopicStore } from "./topics";
const storedTopicChatId = getTopicStore().chatId;
const primaryChatId =
  storedTopicChatId || ([...chatIdSet][0] as number | undefined);
if (primaryChatId !== undefined && storedTopicChatId) {
  setChatId(primaryChatId);
  topicManager = new TopicManager(bot.api, primaryChatId);
  setTopicManager(topicManager);
}

const notifyHandler = createNotificationHandler(
  bot.api,
  topicManager,
  (sessionName, topicId, sessionDir, sessionId) => {
    const chatId = topicManager?.getChatId();
    if (chatId !== undefined && topicId !== undefined) {
      startAutoWatch(bot.api, chatId, topicId, sessionName, {
        fromBeginning: true,
      })
        .then(async () => {
          // Ping the relay to force the JSONL to be created immediately.
          // Without this, the relay can't discover its sessionId until the
          // user types the first terminal message.
          const client = await getRelayClient({ sessionId, sessionDir });
          client?.sendMessage({
            chat_id: String(chatId),
            user: "bridge",
            text: `Session Name: ${sessionName}`,
          });
        })
        .catch((err) =>
          warn(
            `auto-watch on-notify failed for ${sessionName} (topic ${topicId}): ${err}`,
          ),
        );
    }
  },
);
await startWatcher(notifyHandler);

if (topicManager && primaryChatId !== undefined) {
  const sessions = getSessions();
  await topicManager.reconcile(
    sessions.map((s) => ({ name: s.name, dir: s.dir, id: s.id })),
  );

  // Start auto-watch for all online sessions with topics
  for (const s of sessions) {
    const topic = getTopicBySession(s.name);
    if (topic) {
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
    } catch {}
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
