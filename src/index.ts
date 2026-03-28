/**
 * Claude Coding Bot
 *
 * Multi-session Claude Code control via Telegram.
 */

import { run } from "@grammyjs/runner";
import {
  TELEGRAM_TOKEN,
  WORKING_DIR,
  ALLOWED_USERS,
  RESTART_FILE,
} from "./config";
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
  getActiveSession,
  getGitBranch,
} from "./sessions";
import { notifySessionOffline } from "./handlers";
import { createBot } from "./bot";
import { session } from "./session";
import { info, warn } from "./logger";
import { cleanupPermissions } from "./permissions";
import pkg from "../package.json";

// Create bot instance using factory
const bot = createBot({ token: TELEGRAM_TOKEN });

// ============== Startup ==============

info(
  `cwd: ${WORKING_DIR} (${ALLOWED_USERS.length} user${ALLOWED_USERS.length !== 1 ? "s" : ""})`,
);

// Load persisted chat IDs and pinned message IDs
await loadChatIds();
await loadPinnedMessageIds();

// Wire up mode change callback to update pinned status
session.onModeChange = (isPlanMode) => {
  const active = getActiveSession();
  getGitBranch(session.workingDir)
    .then((branch) => {
      const status = {
        sessionName: active?.name || null,
        isPlanMode,
        model: session.modelDisplayName,
        branch,
      };
      for (const chatId of getChatIds()) {
        updatePinnedStatus(bot.api, chatId, status).catch(() => {});
      }
    })
    .catch(() => {});
};

// Wire up watch handler's offline callback for resume flow
setSessionOfflineCallback(notifySessionOffline);

const notifyHandler = createNotificationHandler(bot.api);
await startWatcher(notifyHandler);

// Get bot info
const botInfo = await bot.api.getMe();
info(`bot: @${botInfo.username} ready`);

// Set autocomplete commands
await bot.api.setMyCommands([
  { command: "list", description: "Show all sessions" },
  { command: "switch", description: "Switch to session" },
  { command: "new", description: "Create new session" },
  { command: "plan", description: "Start plan mode" },
  { command: "queue", description: "Queue tasks for batch execution" },
  { command: "watch", description: "Watch a desktop session live" },
  { command: "unwatch", description: "Stop watching" },
  { command: "stop", description: "Interrupt current query" },
  { command: "kill", description: "Terminate session" },
  { command: "retry", description: "Retry last message" },
  { command: "status", description: "Show session details" },
  { command: "model", description: "Show/switch model" },
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

function monitorRunner() {
  runner
    .task()
    ?.then(() => {
      if (!stopping) {
        warn("runner stopped unexpectedly, restarting in 3s");
        setTimeout(() => {
          runner = run(bot);
          monitorRunner();
        }, 3000);
      }
    })
    .catch((err) => {
      if (!stopping) {
        warn(`runner error: ${err}, restarting in 3s`);
        setTimeout(() => {
          runner = run(bot);
          monitorRunner();
        }, 3000);
      }
    });
}
monitorRunner();

// Graceful shutdown
const stopRunner = () => {
  if (runner.isRunning()) {
    stopping = true;
    info("stopping bot");
    stopWatcher();
    cleanupPermissions();
    runner.stop();
  }
};

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
