/**
 * Bot factory module.
 *
 * Exports configurable bot creation for both production and testing.
 * index.ts uses this to create and start the bot.
 */

import { Bot } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import { ALLOWED_USERS } from "./config";
import {
  registerChatId,
  getChatIds,
  getActiveSession,
  updatePinnedStatus,
  getGitBranch,
} from "./sessions";
import { isAuthorized } from "./security";
import { session } from "./session";
import { error as logError, info } from "./logger";
import {
  handleStart,
  handleHelp,
  handleNew,
  handleStop,
  handleKill,
  handleStatus,
  handleModel,
  handleRestart,
  handleRetry,
  handleList,
  handleSwitch,
  handleRefresh,
  handlePin,
  handleSessions,
  handleWatch,
  handleUnwatch,
  handlePwd,
  handleCd,
  handleLs,
  handleUsage,
  handleExecute,
  handleSettings,
  handleText,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleCallback,
} from "./handlers";

export interface BotOptions {
  token: string;
  /** Called when bot first sees a supergroup with forum topics enabled. */
  onForumGroupDetected?: (chatId: number) => void;
}

/**
 * Create a configured bot instance without starting it.
 * Use this for testing or custom startup logic.
 */
export function createBot(options: BotOptions): Bot {
  const bot = new Bot(options.token);

  // Sequentialize non-command messages per chat thread (prevents race conditions)
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
      const threadId = ctx.message?.message_thread_id;
      return threadId
        ? `${ctx.chat?.id}:${threadId}`
        : ctx.chat?.id?.toString();
    }),
  );

  // Register chat IDs of allowed users for proactive notifications
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && ctx.chat?.id && isAuthorized(userId, ALLOWED_USERS)) {
      const isNew = !getChatIds().has(ctx.chat.id);
      registerChatId(ctx.chat.id);

      // Detect group chats with forum topics — notify caller
      if (
        isNew &&
        ctx.chat.type === "supergroup" &&
        (ctx.chat as any).is_forum &&
        options.onForumGroupDetected
      ) {
        options.onForumGroupDetected(ctx.chat.id);
      }

      // Create pinned status for new chats
      if (isNew) {
        const active = getActiveSession();
        getGitBranch(session.workingDir)
          .then((branch) =>
            updatePinnedStatus(bot.api, ctx.chat!.id, {
              sessionName: active?.name || null,
              isPlanMode: session.isPlanMode,
              model: session.modelDisplayName,
              branch,
            }),
          )
          .catch(() => {});
      }
    }
    await next();
  });

  // Command handlers
  bot.command("start", handleStart);
  bot.command("help", handleHelp);
  bot.command("new", handleNew);
  bot.command("stop", handleStop);
  bot.command("kill", handleKill);
  bot.command("status", handleStatus);
  bot.command("model", handleModel);
  bot.command("restart", handleRestart);
  bot.command("retry", handleRetry);
  bot.command("list", handleList);
  bot.command("switch", handleSwitch);
  bot.command("refresh", handleRefresh);
  bot.command("watch", handleWatch);
  bot.command("unwatch", handleUnwatch);
  bot.command("pin", handlePin);
  bot.command("sessions", handleSessions);
  bot.command("pwd", handlePwd);
  bot.command("cd", handleCd);
  bot.command("ls", handleLs);
  bot.command("usage", handleUsage);
  bot.command("execute", handleExecute);
  bot.command("settings", handleSettings);

  // Message handlers
  bot.on("message:text", handleText);
  bot.on("message:voice", handleVoice);
  bot.on("message:photo", handlePhoto);
  bot.on("message:document", handleDocument);

  // Callback queries
  bot.on("callback_query:data", handleCallback);

  // Error handler
  bot.catch((err) => {
    logError("bot: unhandled error", err.error, {
      chatId: err.ctx?.chat?.id,
      fromId: err.ctx?.from?.id,
    });
  });

  return bot;
}
