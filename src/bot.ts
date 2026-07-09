/**
 * Bot factory module.
 *
 * Exports configurable bot creation for both production and testing.
 * index.ts uses this to create and start the bot.
 */

import { Bot, type Context } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import { autoRetry } from "@grammyjs/auto-retry";
import { installBridgeHealthTransformer } from "./bridge-health";
import { createMessageBus, setMessageBus } from "./messaging";
import { ALLOWED_USERS } from "./config";
import { getGroupModeSetting } from "./settings";
import {
  registerChatId,
  getChatIds,
  getSessions,
  updatePinnedStatus,
  getGitBranch,
  resolveSessionContext,
  type SessionContext,
} from "./sessions";
import { isAuthorized } from "./security";
import { getCurrentModelDisplayName } from "./session";
import { error as logError, info, warn, debug } from "./logger";
import {
  handleStart,
  handleHelp,
  handleNew,
  handleRespawn,
  handleStop,
  handleInterrupt,
  handleKill,
  handleStatus,
  handleModel,
  handleRestart,
  handleRetry,
  handleList,
  handleSwitch,
  handleRefresh,
  handlePin,
  handleGroupMode,
  handleVerbose,
  handleTmux,
  handlePeek,
  handleCursorBridge,
  handleCleanZombie,
  handleCron,
  handleRalph,
  handlePrompts,
  handleSkills,
  handleClear,
  handleCompact,
  handleContext,
  handleSessions,
  handleWatch,
  handleUnwatch,
  handlePwd,
  handleCd,
  handleLs,
  handleUsage,
  handleExecute,
  handleSettings,
  handleApp,
  handleRun,
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
  // Install the global MessageBus singleton. All handlers route outbound
  // messages through getMessageBus().send/.edit — this is the only
  // construction site.
  setMessageBus(createMessageBus(bot.api));
  let forumGroupDetected = false;

  // Honor Telegram's retry_after on 429 responses so transient throttling
  // (e.g. after a long reply) doesn't silently drop the next message in
  // sendHtmlWithPlainFallback. Caps wait at 60s — anything longer fails fast.
  bot.api.config.use(autoRetry({ maxDelaySeconds: 60, maxRetryAttempts: 5 }));

  // Track Telegram reachability AFTER autoRetry so we only see post-retry
  // failures. Watch handlers consult isBridgeOnline() to drop tail-event
  // sends during outages instead of letting them pile up in grammy's queue.
  installBridgeHealthTransformer(bot.api);

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

  // Topic discovery — every inbound thread_id we haven't seen gets recorded as
  // a `discovered-<id>` ledger entry so `/cleanzombie` can find pre-ledger
  // orphans the bot lost track of. Fire-and-forget, idempotent.
  bot.use(async (ctx, next) => {
    const tid = ctx.message?.message_thread_id;
    if (tid && tid !== 1) {
      const { getSessionByTopic, recordTopicDiscovered } =
        await import("./topics");
      if (!getSessionByTopic(tid)) {
        recordTopicDiscovered(tid).catch(() => {});
      }
    }
    await next();
  });

  // Stall detection — warn if a handler runs longer than 30s. Placed after
  // sequentialize so the timer measures handler execution only, not queue wait.
  bot.use(async (ctx, next) => {
    const startedAt = Date.now();
    const chatId = ctx.chat?.id;
    const threadId = ctx.message?.message_thread_id;
    const kind = ctx.callbackQuery
      ? "callback"
      : ctx.message?.text
        ? "text"
        : ctx.message?.voice
          ? "voice"
          : ctx.message?.photo
            ? "photo"
            : ctx.message?.document
              ? "document"
              : "other";
    const stallTimer = setTimeout(() => {
      warn("bot: handler still running after 30s", {
        chatId,
        threadId,
        kind,
        elapsedMs: Date.now() - startedAt,
      });
    }, 30_000);
    try {
      await next();
    } finally {
      clearTimeout(stallTimer);
    }
  });

  // Register chat IDs of allowed users for proactive notifications
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;

    // Central auth gate — silently drop unauthorised users before any
    // processing. No reply (don't confirm bot existence to strangers).
    if (userId === undefined || !isAuthorized(userId, ALLOWED_USERS)) {
      debug("bot: dropped update from unauthorised user", { userId });
      return;
    }

    if (ctx.chat?.id) {
      const isNew = !getChatIds().has(ctx.chat.id);
      registerChatId(ctx.chat.id);

      // Detect group chats with forum topics — notify caller
      // is_forum may not be on the message update, so also check via getChat()
      if (
        !forumGroupDetected &&
        ctx.chat.type === "supergroup" &&
        options.onForumGroupDetected
      ) {
        const isForum = (ctx.chat as { is_forum?: boolean }).is_forum;
        if (isForum) {
          forumGroupDetected = true;
          options.onForumGroupDetected(ctx.chat.id);
        } else if (!forumGroupDetected) {
          // is_forum might not be in the update — check via API (once)
          forumGroupDetected = true; // set eagerly to prevent parallel getChat calls
          bot.api
            .getChat(ctx.chat.id)
            .then((chat) => {
              if ((chat as { is_forum?: boolean }).is_forum) {
                options.onForumGroupDetected!(ctx.chat!.id);
              } else {
                forumGroupDetected = false; // not a forum — allow retry
              }
            })
            .catch(() => {
              forumGroupDetected = false;
            });
        }
      }

      // Create pinned status for new chats. Working dir + active-session
      // name come from the registry (SessionInfo); model is global (R3);
      // plan mode defaults to false at boot since no SessionState is
      // warmed yet — the first query will fire a mode_change event that
      // refreshes the pin.
      if (isNew) {
        // No global "active" pointer after task 7g. Seed the pinned status
        // from the most-recently-active session in the registry; mode_change
        // events on future SessionState creations will refresh the pin.
        const first = getSessions()[0];
        const dir = first?.dir ?? process.cwd();
        getGitBranch(dir)
          .then((branch) =>
            updatePinnedStatus(bot.api, ctx.chat!.id, {
              sessionName: first?.name || null,
              isPlanMode: false,
              model: getCurrentModelDisplayName(),
              branch,
            }),
          )
          .catch(() => {});
      }
    }
    // Explicit setting overrides runtime detection. Only block on explicit
    // mode choice — in auto mode, let messages through so plain supergroups
    // (non-forum) aren't silently blocked while detection is still pending.
    const setting = getGroupModeSetting();
    const groupMode = setting ?? forumGroupDetected;

    if (groupMode && ctx.chat?.type === "private") {
      if (ctx.message) {
        await ctx
          .reply("ℹ️ Bot is running in group mode. Use the group chat.")
          .catch(() => {});
      }
      return;
    }
    if (setting === false && ctx.chat?.type === "supergroup") {
      if (ctx.message) {
        await ctx
          .reply(
            "ℹ️ Bot is running in private mode. Use the DM.\n" +
              "Switch with /groupmode on in the DM.",
            { message_thread_id: ctx.message.message_thread_id },
          )
          .catch(() => {});
      }
      return;
    }

    await next();
  });

  // Command handlers. Session-aware commands receive the SessionContext
  // resolved at the bot edge (topic-first). Session-agnostic commands
  // (/help, /new, /list, /switch, /refresh, /sessions, /restart, /usage,
  // /execute, /settings, /app, /run, /watch, /unwatch, /retry, /groupmode,
  // /cleanzombie) keep their original signatures.
  const withSctx =
    <T extends (ctx: Context, sctx?: SessionContext) => Promise<void>>(
      handler: T,
    ) =>
    async (ctx: Parameters<T>[0]) =>
      handler(ctx, resolveSessionContext(ctx));

  bot.command("start", withSctx(handleStart));
  bot.command("help", handleHelp);
  bot.command("new", handleNew);
  bot.command("respawn", withSctx(handleRespawn));
  bot.command("stop", withSctx(handleStop));
  bot.command("interrupt", withSctx(handleInterrupt));
  bot.command("kill", withSctx(handleKill));
  bot.command("status", withSctx(handleStatus));
  bot.command("model", withSctx(handleModel));
  bot.command("restart", handleRestart);
  bot.command("retry", withSctx(handleRetry));
  bot.command("list", handleList);
  bot.command("switch", handleSwitch);
  bot.command("refresh", handleRefresh);
  bot.command("watch", withSctx(handleWatch));
  bot.command("unwatch", withSctx(handleUnwatch));
  bot.command("pin", withSctx(handlePin));
  bot.command("groupmode", handleGroupMode);
  bot.command("verbose", handleVerbose);
  bot.command("tmux", handleTmux);
  bot.command("peek", handlePeek);
  bot.command("cursor", handleCursorBridge);
  bot.command("cleanzombie", handleCleanZombie);
  bot.command("cron", withSctx(handleCron));
  bot.command("ralph", handleRalph);
  bot.command("prompts", withSctx(handlePrompts));
  bot.command("skills", withSctx(handleSkills));
  bot.command("clear", withSctx(handleClear));
  bot.command("compact", withSctx(handleCompact));
  bot.command("context", withSctx(handleContext));
  bot.command("sessions", handleSessions);
  bot.command("pwd", withSctx(handlePwd));
  bot.command("cd", withSctx(handleCd));
  bot.command("ls", withSctx(handleLs));
  bot.command("app", handleApp);
  bot.command("run", handleRun);
  bot.command("usage", handleUsage);
  bot.command("execute", handleExecute);
  bot.command("settings", handleSettings);

  // Message handlers
  bot.on("message:text", async (ctx) => {
    await handleText(ctx, resolveSessionContext(ctx));
  });
  bot.on("message:voice", async (ctx) => {
    await handleVoice(ctx, resolveSessionContext(ctx));
  });
  bot.on("message:photo", async (ctx) => {
    await handlePhoto(ctx, resolveSessionContext(ctx));
  });
  bot.on("message:document", async (ctx) => {
    await handleDocument(ctx, resolveSessionContext(ctx));
  });

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
