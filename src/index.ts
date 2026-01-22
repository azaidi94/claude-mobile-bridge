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
import { startWatcher, stopWatcher } from "./sessions";
import { createBot } from "./bot";
import pkg from "../package.json";

// Create bot instance using factory
const bot = createBot({ token: TELEGRAM_TOKEN });

// ============== Startup ==============

console.log("=".repeat(50));
console.log(`Claude Coding Bot v${pkg.version}`);
console.log("=".repeat(50));
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);

// Start session watcher
await startWatcher();

// Get bot info
const botInfo = await bot.api.getMe();
console.log(`Bot started: @${botInfo.username}`);

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
    console.warn("Failed to update restart message:", e);
    try {
      unlinkSync(RESTART_FILE);
    } catch {}
  }
}

// Start bot
const runner = run(bot);

// Graceful shutdown
const stopRunner = () => {
  if (runner.isRunning()) {
    console.log("Stopping bot...");
    stopWatcher();
    runner.stop();
  }
};

process.on("SIGINT", () => {
  console.log("Received SIGINT");
  stopRunner();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM");
  stopRunner();
  process.exit(0);
});
