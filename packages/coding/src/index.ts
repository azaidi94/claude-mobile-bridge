/**
 * Claude Coding Bot
 *
 * Multi-session Claude Code control via Telegram.
 */

import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { TELEGRAM_TOKEN, WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "./config";
import { unlinkSync, readFileSync, existsSync } from "fs";
import { startWatcher, stopWatcher } from "./sessions";
import {
  handleStart,
  handleHelp,
  handleNew,
  handleStop,
  handleStatus,
  handleRestart,
  handleRetry,
  handleList,
  handleSwitch,
  handleRefresh,
  handleText,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleCallback,
} from "./handlers";

// Create bot instance
const bot = new Bot(TELEGRAM_TOKEN);

// Sequentialize non-command messages per user (prevents race conditions)
bot.use(
  sequentialize((ctx) => {
    // Commands bypass sequentialization
    if (ctx.message?.text?.startsWith("/")) {
      return undefined;
    }
    // Messages with ! prefix bypass queue (interrupt)
    if (ctx.message?.text?.startsWith("!")) {
      return undefined;
    }
    // Callback queries not sequentialized
    if (ctx.callbackQuery) {
      return undefined;
    }
    return ctx.chat?.id.toString();
  })
);

// ============== Command Handlers ==============

bot.command("start", handleStart);
bot.command("help", handleHelp);
bot.command("new", handleNew);
bot.command("stop", handleStop);
bot.command("status", handleStatus);
bot.command("restart", handleRestart);
bot.command("retry", handleRetry);
bot.command("list", handleList);
bot.command("switch", handleSwitch);
bot.command("refresh", handleRefresh);

// ============== Message Handlers ==============

bot.on("message:text", handleText);
bot.on("message:voice", handleVoice);
bot.on("message:photo", handlePhoto);
bot.on("message:document", handleDocument);

// ============== Callback Queries ==============

bot.on("callback_query:data", handleCallback);

// ============== Error Handler ==============

bot.catch((err) => {
  console.error("Bot error:", err);
});

// ============== Startup ==============

console.log("=".repeat(50));
console.log("Claude Coding Bot");
console.log("=".repeat(50));
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);

// Start session watcher
await startWatcher(() => {
  console.log("Sessions updated");
});

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
        "✅ Restarted"
      );
    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    console.warn("Failed to update restart message:", e);
    try { unlinkSync(RESTART_FILE); } catch {}
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
