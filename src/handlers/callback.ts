/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses (ask_user MCP integration, plan approval).
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import {
  runQueryStreaming,
  runPlanApproval,
  MODEL_DISPLAY_NAMES,
  MODEL_OPTIONS,
  getCurrentModel,
  getCurrentModelDisplayName,
  setCurrentModel,
  type ModelId,
} from "../session";
import { getSessionState } from "../sessions/session-state";
import { ALLOWED_USERS } from "../config";
import { formatTimeAgo, escapeHtml } from "../formatting";
import { isAuthorized } from "../security";
import { auditLog, startTypingIndicator } from "../utils";
import {
  StreamingState,
  createStatusCallback,
  createPlanApprovalKeyboard,
  createAskUserQuestionKeyboard,
  pendingAskUserQuestions,
  pendingAskUserQuestionCustom,
  sendPlanContent,
  pendingKey,
} from "./streaming";
import {
  setActiveSession,
  getSessions,
  getSession,
  updatePinnedStatus,
  getGitBranch,
  sendSwitchHistory,
  resolveSessionContext,
} from "../sessions";
import { sessionContextFromInfo } from "../sessions/context";
import type { SessionContext } from "../sessions/context";
import { isWatchingAny } from "./watch";
import {
  killSession,
  sendPostKillSessionList,
  offlineSessionCache,
  spawnDesktopClaudeSession,
  handleGroupModeCallback,
  handleTmuxCallback,
  handleTuiCallback,
  handleCursorBridgeCallback,
  handleCursorSubscribe,
  respawnSession,
} from "./commands";
import {
  pendingSettingsInput,
  rerenderSettingsPanel,
  TERMINAL_LABELS,
  VERBOSE_LABELS,
} from "./settings";
import {
  saveSetting,
  getTerminal,
  getWorkingDir,
  getOverrides,
  getEnablePinnedStatus,
  getContextNotifyStep,
  getVerboseLevel,
  getDefaultRalphLabel,
} from "../settings";
import type { TerminalApp } from "../config";
import { debug, error as logError, info, warn } from "../logger";
import {
  getExecuteCommands,
  startProcess,
  stopProcess,
  buildExecuteMenu,
} from "./execute";
import { handleAskRemoteCallback, handleBridgeCallback } from "./relay-ask";
import { handlePermissionCallback } from "./permission-relay";
import { getMessageBus } from "../messaging";

/**
 * Bus-routed reply helper. ctx.editMessageText / ctx.answerCallbackQuery /
 * ctx.editMessageReplyMarkup stay inline — they're TG callback-flow
 * primitives that the bus doesn't model.
 */
function busReply(
  ctx: Context,
  content: string,
  opts: {
    format?: "plain" | "html";
    replyMarkup?: import("grammy/types").InlineKeyboardMarkup;
  } = {},
): Promise<unknown> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return Promise.resolve();
  return getMessageBus().send({
    chatId,
    threadId: ctx.callbackQuery?.message?.message_thread_id,
    content,
    format: opts.format ?? "plain",
    replyMarkup: opts.replyMarkup,
  });
}

// Track pending plan feedback by (chatId, threadId) — composite key prevents
// sibling forum topics from consuming each other's replies.
export const pendingPlanFeedback = new Map<string, string>(); // pendingKey -> requestId

/** Origin badge for the skill confirm card. */
function skillOriginLabel(origin: "user" | "project" | "plugin"): string {
  if (origin === "project") return "📌 project";
  if (origin === "plugin") return "🧩 plugin";
  return "⭐ personal";
}

/**
 * Skills-browser callbacks (skill:*). Resolves the entry against the topic's
 * cwd, renders the confirm card, injects on run, or captures args.
 */
async function handleSkillCallback(
  ctx: Context,
  data: string,
  sctx: SessionContext | undefined,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const threadId = ctx.callbackQuery?.message?.message_thread_id;

  if (data === "skill:noop") {
    await ctx.answerCallbackQuery();
    return;
  }

  // Landing (⌂ Skills back button) and origin-group drill-down.
  if (data === "skill:home" || data.startsWith("skill:grp:")) {
    if (!sctx) {
      await ctx.answerCallbackQuery({
        text: "Open /skills in a session topic",
      });
      return;
    }
    const { buildLanding, buildGroup } = await import("./commands/skills");
    let built: { text: string; replyMarkup: unknown } | null;
    if (data === "skill:home") {
      built = await buildLanding(sctx.sessionDir);
    } else {
      const [, , origin, pageStr] = data.split(":");
      built = buildGroup(
        sctx.sessionDir,
        origin as "user" | "project" | "plugin",
        parseInt(pageStr ?? "", 10) || 0,
      );
    }
    await ctx.answerCallbackQuery().catch(() => {});
    if (built) {
      await ctx
        .editMessageText(built.text, {
          parse_mode: "HTML",
          reply_markup: built.replyMarkup as never,
        })
        .catch(() => {});
    }
    return;
  }

  // Pagination: skill:pg:<page>:<query...> (query may contain colons).
  if (data.startsWith("skill:pg:")) {
    const rest = data.slice("skill:pg:".length);
    const sep = rest.indexOf(":");
    const page = parseInt(sep === -1 ? rest : rest.slice(0, sep), 10) || 0;
    const query = sep === -1 ? "" : rest.slice(sep + 1);
    if (!sctx) {
      await ctx.answerCallbackQuery({
        text: "Open /skills in a session topic",
      });
      return;
    }
    const { buildSearch } = await import("./commands/skills");
    const built = buildSearch(sctx.sessionDir, query, page);
    await ctx.answerCallbackQuery().catch(() => {});
    if (built) {
      await ctx
        .editMessageText(built.text, {
          parse_mode: "HTML",
          reply_markup: built.replyMarkup,
        })
        .catch(() => {});
    }
    return;
  }

  const m = /^skill:(run|go|args):(\d+)$/.exec(data);
  if (!m) {
    await ctx.answerCallbackQuery();
    return;
  }
  const action = m[1];
  const idx = parseInt(m[2] ?? "", 10);

  if (!sctx || sctx.source !== "cc") {
    await ctx.answerCallbackQuery({
      text: "Run /skills in a Claude session topic",
    });
    return;
  }
  const { discoverSkills } = await import("../skills/discovery");
  const entry = discoverSkills(sctx.sessionDir)[idx];
  if (!entry) {
    await ctx.answerCallbackQuery({
      text: "Skill list changed — reopen /skills",
    });
    return;
  }

  if (action === "run") {
    const badge = skillOriginLabel(entry.origin);
    const desc = entry.description
      ? escapeHtml(entry.description)
      : "<i>no description</i>";
    const reply_markup = {
      inline_keyboard: [
        [
          { text: `▶ Run /${entry.name}`, callback_data: `skill:go:${idx}` },
          { text: "✎ With args…", callback_data: `skill:args:${idx}` },
        ],
      ],
    };
    const text = `<b>/${escapeHtml(entry.name)}</b> — ${badge} ${entry.kind}\n${desc}`;
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx
      .editMessageText(text, { parse_mode: "HTML", reply_markup })
      .catch(() =>
        busReply(ctx, text, { format: "html", replyMarkup: reply_markup }),
      );
    return;
  }

  if (action === "args") {
    if (chatId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    const { pendingSkillArgs } = await import("./commands/skills");
    pendingSkillArgs.set(pendingKey(chatId, threadId), entry.name);
    await ctx.answerCallbackQuery().catch(() => {});
    // force_reply so the user's next message is captured as args (text.ts).
    await ctx
      .reply(`Reply with args for /${entry.name} (or /cancel):`, {
        message_thread_id: threadId,
        reply_markup: {
          force_reply: true,
          input_field_placeholder: `args for /${entry.name}`,
        },
      })
      .catch(() => {});
    return;
  }

  // action === "go": run with no args.
  const { runSkill } = await import("./commands/skills");
  await ctx.answerCallbackQuery({ text: `▶ /${entry.name}` }).catch(() => {});
  const result = await runSkill(sctx, entry.name, "");
  await busReply(
    ctx,
    result.ok
      ? `▶ Sent /${entry.name} → ${sctx.sessionName}`
      : `❌ Couldn't send /${entry.name}: ${result.reason}`,
  );
}

/**
 * Handle callback queries from inline keyboards.
 */
export async function handleCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;
  const threadId = ctx.callbackQuery?.message?.message_thread_id;

  if (!userId || !chatId || !callbackData) {
    await ctx.answerCallbackQuery();
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }

  // Handle topic session-picker callbacks. The user picked a session from
  // the General-topic picker; build an sctx from it and dispatch to the
  // handler exactly as if they'd invoked it from that session's topic.
  for (const [prefix, handler] of [
    ["status_pick:", "handleStatus"],
    ["model_pick:", "handleModel"],
    ["stop_pick:", "handleStop"],
    ["clear_pick:", "handleClear"],
    ["compact_pick:", "handleCompact"],
    ["context_pick:", "handleContext"],
    ["skills_pick:", "handleSkills"],
  ] as const) {
    if (callbackData.startsWith(prefix)) {
      const sessionName = callbackData.slice(prefix.length);
      const sessionInfo = getSession(sessionName);
      if (sessionInfo) {
        const sctx = sessionContextFromInfo(sessionInfo, chatId);
        const commands = await import("./commands");
        await (
          commands[handler] as (
            ctx: Context,
            sctx?: SessionContext,
          ) => Promise<void>
        )(ctx, sctx);
      } else {
        await busReply(ctx, "Session not found.");
      }
      await ctx.answerCallbackQuery();
      return;
    }
  }

  // SessionContext for the originating topic (if any). Some callback
  // branches use this to render correct pinned-status names and avoid
  // mis-routing to whichever session the singleton last touched.
  const sctx = resolveSessionContext(ctx);

  // Saved-prompt tap: inject the prompt's text into the originating session
  // as if the user had typed it. Must come before the model branch so a
  // future button with `prompt:` prefix doesn't shadow.
  if (callbackData.startsWith("prompt:")) {
    const id = callbackData.slice(7);
    const { getById } = await import("../prompts/store");
    const saved = await getById(id);
    if (!saved) {
      await ctx.answerCallbackQuery({ text: "prompt missing" });
      return;
    }
    const preview =
      saved.text.length > 60 ? saved.text.slice(0, 60) + "…" : saved.text;
    if (!sctx) {
      await ctx.answerCallbackQuery({
        text: "Tap prompts in a session topic",
      });
      return;
    }
    const username = ctx.from?.username || "telegram";
    // Acknowledge immediately — TG callback queries expire in ~15-30 s and
    // sendViaRelay can block up to RELAY_RESPONSE_TIMEOUT_MS (300 s).
    await ctx.answerCallbackQuery({ text: `▶ ${preview}` }).catch(() => {});
    const { sendViaRelay } = await import("./relay-bridge");
    const result = await sendViaRelay(
      ctx,
      saved.text,
      username,
      chatId,
      undefined,
      undefined,
      ctx.callbackQuery?.message?.message_thread_id,
      sctx,
    );
    if (result === "delivered") {
      await auditLog(userId, username, "PROMPT_TAP", saved.id, preview);
    } else {
      await busReply(
        ctx,
        `❌ ${result === "unavailable" ? "session offline" : "send failed"}`,
      );
    }
    return;
  }

  // Skills browser: run / confirm-args / paginate. Injects the chosen slash
  // command into the desktop TUI (like /clear), NOT via the model relay.
  if (callbackData.startsWith("skill:")) {
    await handleSkillCallback(ctx, callbackData, sctx);
    return;
  }

  // 2. Model switch: model:{sessionName}:{configArg}. Injects
  //    `/config model=<configArg>` into the session's live desktop TUI — a
  //    documented one-shot that bypasses the interactive picker and persists.
  //    The tailer echoes the TUI's `Set Model to …` line back to the topic, so
  //    we don't render a (now-unknowable) current-model checkmark here.
  if (callbackData.startsWith("model:")) {
    // Format: model:<idx>:<sessionName> — idx first (fixed, short) keeps
    // callback_data under Telegram's 64-byte limit; the name is the last
    // segment so it may itself contain ":".
    const rest = callbackData.slice(6);
    const sep = rest.indexOf(":");
    const idx = sep >= 0 ? Number(rest.slice(0, sep)) : NaN;
    const sessionName = sep >= 0 ? rest.slice(sep + 1) : "";
    const opt = MODEL_OPTIONS[idx];
    if (!opt || !sessionName) {
      await ctx.answerCallbackQuery({ text: "Invalid model" });
      return;
    }
    const info = getSession(sessionName);
    if (!info) {
      await ctx.answerCallbackQuery({ text: "Session not found" });
      return;
    }
    const target = sessionContextFromInfo(info, chatId);
    if (target.source !== "cc") {
      await ctx.answerCallbackQuery({
        text: `Not supported for ${target.source} sessions`,
      });
      return;
    }
    // Ack immediately — TG callback queries expire fast and injection can block.
    await ctx
      .answerCallbackQuery({ text: `Switching to ${opt.label}…` })
      .catch(() => {});
    const { sendKeysToSession } = await import("./commands/terminal-inject");
    const result = await sendKeysToSession(
      target,
      `/config model=${opt.configArg}`,
    );
    const body = result.ok
      ? `🤖 <b>Model → ${opt.label}</b>${result.note ? ` <i>(${result.note})</i>` : ""}`
      : `❌ Couldn't switch model: ${result.reason}`;
    await ctx.editMessageText(body, { parse_mode: "HTML" }).catch(() => {});
    return;
  }

  // 3. Handle switch callbacks: switch:{session_name}
  if (callbackData.startsWith("switch:")) {
    const name = callbackData.slice(7); // Remove "switch:" prefix
    const targetInfo = getSession(name);

    if (!targetInfo) {
      await ctx.answerCallbackQuery({ text: "Session not found" });
      return;
    }

    const success = setActiveSession(name);

    if (success) {
      const active = targetInfo;
      {
        getSessionState(active.name).loadFromRegistry(active);

        // Rebuild buttons with updated active checkmark — tiny title only,
        // matching handleList (no per-session meta text).
        const sessions = getSessions();
        const buttons = sessions.map((s) => [
          {
            text: active.name === s.name ? `✓ ${s.name}` : s.name,
            callback_data: `switch:${s.name}`,
          },
        ]);

        await ctx.editMessageText("📋 <b>Sessions</b>", {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons },
        });
        await ctx.answerCallbackQuery({ text: `Switched to ${name}` });

        await sendSwitchHistory(ctx, active);
        getGitBranch(active.dir)
          .then((branch) =>
            updatePinnedStatus(ctx.api, chatId, {
              sessionName: active.name,
              isPlanMode: getSessionState(active.name).isPlanMode,
              model: getCurrentModelDisplayName(),
              branch,
            }),
          )
          .catch(() => {});
      }
    } else {
      await ctx.answerCallbackQuery({ text: "Session not found" });
    }
    return;
  }

  // 4. Handle kill callbacks: kill:{session_name}
  if (callbackData.startsWith("kill:")) {
    const name = callbackData.slice(5);
    const target = getSession(name);

    if (!target) {
      await ctx.answerCallbackQuery({ text: "Session not found" });
      return;
    }

    const { pid } = await killSession(target, chatId, ctx.api);
    const pidStr = pid ? ` (pid ${pid})` : "";
    await ctx.answerCallbackQuery({ text: `Killed ${name}` });

    await ctx.editMessageText(`💀 Killed <b>${escapeHtml(name)}</b>${pidStr}`, {
      parse_mode: "HTML",
    });
    await sendPostKillSessionList(ctx, chatId, "switch");
    return;
  }

  // Handle respawn callbacks: respawn:{session_name}
  if (callbackData.startsWith("respawn:")) {
    const name = callbackData.slice(8);
    const target = getSession(name);
    const userId = ctx.from?.id;

    if (!target || userId === undefined) {
      await ctx.answerCallbackQuery({ text: "Session not found" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Respawning ${name}` });
    await ctx.editMessageText(`♻️ Respawning <b>${escapeHtml(name)}</b>...`, {
      parse_mode: "HTML",
    });
    await respawnSession(ctx.api, chatId, userId, target);
    return;
  }

  // Handle offline session pick: sess_pick:{gen}:{idx}
  if (callbackData.startsWith("sess_pick:")) {
    const parts = callbackData.split(":");
    const gen = parseInt(parts[1] ?? "", 10);
    const idx = parseInt(parts[2] ?? "", 10);
    const cached = offlineSessionCache.get(chatId);
    const s = cached && cached.gen === gen ? cached.sessions[idx] : undefined;

    if (!s) {
      await ctx.answerCallbackQuery({
        text: "Session list expired. Run /sessions again.",
      });
      return;
    }

    const dir = s.dir.replace(/^\/Users\/[^/]+/, "~");
    const ago = formatTimeAgo(s.lastActivity);
    const lines = [`📁 <b>${escapeHtml(dir)}</b>`, ago];
    if (s.lastMessage) {
      lines.push(`\n<i>${escapeHtml(s.lastMessage)}</i>`);
    }

    await ctx.editMessageText(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "▶️ Resume",
              callback_data: `sess_resume:${gen}:${idx}`,
            },
            { text: "✖ Cancel", callback_data: "sess_cancel" },
          ],
        ],
      },
    });
    await ctx.answerCallbackQuery();
    return;
  }

  // Handle offline session resume: sess_resume:{gen}:{idx}
  if (callbackData.startsWith("sess_resume:")) {
    const parts = callbackData.split(":");
    const gen = parseInt(parts[1] ?? "", 10);
    const idx = parseInt(parts[2] ?? "", 10);
    const cached = offlineSessionCache.get(chatId);
    const s = cached && cached.gen === gen ? cached.sessions[idx] : undefined;

    if (!s) {
      await ctx.answerCallbackQuery({
        text: "Session list expired. Run /sessions again.",
      });
      return;
    }

    const dir = s.dir.replace(/^\/Users\/[^/]+/, "~");
    await ctx.editMessageText(
      `🚀 Spawning desktop session...\n📁 <code>${escapeHtml(dir)}</code>`,
      { parse_mode: "HTML" },
    );
    await ctx.answerCallbackQuery();

    await spawnDesktopClaudeSession(ctx.api, chatId, s.dir, userId);
    return;
  }

  // Handle execute start/stop: execute:{start|stop}:{idx}
  if (callbackData.startsWith("execute:")) {
    const [, action, idxStr] = callbackData.split(":");
    const idx = Number(idxStr);
    const commands = getExecuteCommands();
    const cmd = commands[idx];

    if (!cmd || isNaN(idx)) {
      await ctx.answerCallbackQuery({ text: "Command not found" });
      return;
    }

    if (action === "start") {
      startProcess(idx, cmd);
      await ctx.answerCallbackQuery({ text: `▶ Started ${cmd.name}` });
    } else {
      stopProcess(idx);
      await ctx.answerCallbackQuery({ text: `■ Stopped ${cmd.name}` });
    }

    // Refresh the menu in-place
    const { text, keyboard } = buildExecuteMenu(commands);
    await ctx
      .editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      })
      .catch((err) =>
        debug("execute menu refresh failed", { err: String(err) }),
      );
    return;
  }

  // Handle offline session cancel: sess_cancel
  if (callbackData === "sess_cancel") {
    await ctx.editMessageText("✖ Cancelled.");
    await ctx.answerCallbackQuery();
    return;
  }

  // 5. Handle plan approval callbacks: plan:{action}:{request_id}
  if (callbackData.startsWith("plan:")) {
    const parts = callbackData.split(":");
    if (parts.length !== 3) {
      await ctx.answerCallbackQuery({ text: "Invalid callback" });
      return;
    }

    const action = parts[1] as "accept" | "reject" | "edit";
    const requestId = parts[2]!;

    // Plan approvals require a resolved per-session SessionState. The
    // no-sctx (DM) path has no session to attribute the approval to —
    // surfacing "No pending plan" is correct.
    const state =
      sctx && sctx.source === "cc"
        ? getSessionState(sctx.sessionName)
        : undefined;
    const pendingApproval = state?.pendingPlanApproval;

    if (!pendingApproval) {
      await ctx.answerCallbackQuery({ text: "No pending plan" });
      return;
    }

    if (action === "edit") {
      // Store pending feedback state
      pendingPlanFeedback.set(pendingKey(chatId, threadId), requestId);
      await ctx.editMessageText("✏️ Reply with your feedback for the plan:");
      await ctx.answerCallbackQuery({ text: "Send your feedback" });
      return;
    }

    // Accept or Reject
    await ctx.editMessageText(
      action === "accept" ? "✅ Plan accepted" : "❌ Plan rejected",
    );
    await ctx.answerCallbackQuery({
      text: action === "accept" ? "Accepted" : "Rejected",
    });

    // Start typing
    const typing = startTypingIndicator(ctx);
    const streamState = new StreamingState();
    const statusCallback = createStatusCallback(ctx, streamState);

    try {
      const feedback = action === "reject" ? "User rejected the plan." : "";
      const response = await runPlanApproval(state!, {
        action,
        feedback,
        username,
        userId,
        statusCallback,
        chatId,
        ctx,
        model: getCurrentModel(),
      });

      // Check if another plan approval is pending (for reject flow)
      const nextPending = state!.pendingPlanApproval;
      if (nextPending) {
        const newRequestId = `${Date.now()}`;
        const keyboard = createPlanApprovalKeyboard(newRequestId);
        await busReply(ctx, "📋 Revised plan ready. Review and approve?", {
          replyMarkup: keyboard,
        });
      }

      await auditLog(
        userId,
        username,
        "PLAN_" + action.toUpperCase(),
        "",
        response,
      );
    } catch (error) {
      logError("callback: plan approval failed", error, {
        chatId,
        userId,
        username,
        session: sctx?.sessionName,
        topic: threadId,
        action,
      });
      await busReply(ctx, `❌ Error: ${String(error).slice(0, 200)}`);
    } finally {
      typing.stop();
    }
    return;
  }

  // 5. Handle AskUserQuestion callbacks: auq:{requestId}:{action}:{optionIdx?}
  if (callbackData.startsWith("auq:")) {
    const parts = callbackData.split(":");
    if (parts.length < 3) {
      await ctx.answerCallbackQuery({ text: "Invalid callback" });
      return;
    }

    const requestId = parts[1]!;
    const action = parts[2]!; // "opt", "custom", "skip"
    const optionIdx =
      parts[3] !== undefined ? parseInt(parts[3]!, 10) : undefined;

    const pending = pendingAskUserQuestions.get(requestId);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Expired" });
      return;
    }

    // Resolve per-session state from sctx when present (task 7d).
    const auqState =
      sctx && sctx.source === "cc"
        ? getSessionState(sctx.sessionName)
        : undefined;

    if (action === "skip") {
      // Skip all - send generic response to Claude
      pendingAskUserQuestions.delete(requestId);
      await ctx.editMessageText("⏭️ Skipped questions");
      await ctx.answerCallbackQuery();

      // Send skip message to Claude
      const typing = startTypingIndicator(ctx);
      const streamState = new StreamingState();
      const statusCallback = createStatusCallback(ctx, streamState);

      try {
        if (!auqState) {
          await busReply(ctx, "❌ Question expired — no session.");
          return;
        }
        const response = await runQueryStreaming(auqState, {
          message: "Skip questions, proceed with the plan",
          username,
          userId,
          statusCallback,
          chatId,
          ctx,
          model: getCurrentModel(),
        });
        await auditLog(userId, username, "AUQ_SKIP", "skip", response);
      } catch (error) {
        logError("callback: ask-user skip failed", error, {
          chatId,
          userId,
          username,
          session: sctx?.sessionName,
          topic: threadId,
          requestId,
        });
        await busReply(ctx, `❌ Error: ${String(error).slice(0, 200)}`);
      } finally {
        typing.stop();
      }
      return;
    }

    if (action === "custom") {
      // Store pending custom input
      pendingAskUserQuestionCustom.set(pendingKey(chatId, threadId), requestId);
      const currentQ = pending.questions[pending.currentIndex]!;
      await ctx.editMessageText(
        `✏️ Type your answer:\n\n<i>${currentQ.question}</i>`,
        { parse_mode: "HTML" },
      );
      await ctx.answerCallbackQuery({ text: "Type your answer" });
      return;
    }

    // Option selected
    if (action === "opt" && optionIdx !== undefined) {
      const currentQ = pending.questions[pending.currentIndex]!;
      if (optionIdx < 0 || optionIdx >= currentQ.options.length) {
        await ctx.answerCallbackQuery({ text: "Invalid option" });
        return;
      }

      const selectedOption = currentQ.options[optionIdx]!.label;
      pending.answers.push(selectedOption);
      pending.currentIndex++;

      await ctx.answerCallbackQuery({
        text: `Selected: ${selectedOption.slice(0, 30)}`,
      });

      if (pending.currentIndex < pending.questions.length) {
        // Show next question
        const nextQ = pending.questions[pending.currentIndex]!;
        let questionText = `❓ ${nextQ.question}`;
        if (nextQ.header) {
          questionText = `<b>${nextQ.header}</b>\n\n${questionText}`;
        }
        const keyboard = createAskUserQuestionKeyboard(
          nextQ,
          requestId,
          pending.currentIndex,
          pending.questions.length,
        );
        await ctx.editMessageText(questionText, {
          reply_markup: keyboard,
          parse_mode: "HTML",
        });
      } else {
        // All questions answered - send to Claude
        const wasPlanMode = pending.isPlanMode;
        pendingAskUserQuestions.delete(requestId);
        const answersText = pending.answers.join(", ");
        await ctx.editMessageText(`✅ Answered: ${answersText}`);

        // Send answers to Claude (preserve plan mode)
        const typing = startTypingIndicator(ctx);
        const streamState = new StreamingState();
        const statusCallback = createStatusCallback(ctx, streamState);

        try {
          const permissionMode = wasPlanMode ? "plan" : "bypassPermissions";
          if (!auqState) {
            await busReply(ctx, "❌ Question expired — no session.");
            return;
          }
          const response = await runQueryStreaming(auqState, {
            message: answersText,
            username,
            userId,
            statusCallback,
            chatId,
            ctx,
            permissionMode,
            model: getCurrentModel(),
          });
          await auditLog(userId, username, "AUQ_ANSWER", answersText, response);

          // Check if plan approval is pending (ExitPlanMode was called)
          const pendingForKeyboard = auqState.pendingPlanApproval;
          if (pendingForKeyboard) {
            const displayContent =
              pendingForKeyboard.planContent || pendingForKeyboard.planSummary;
            if (displayContent && displayContent.length > 50) {
              await sendPlanContent(ctx, displayContent);
            }

            const keyboard = createPlanApprovalKeyboard(`${Date.now()}`);
            await busReply(ctx, "Review and approve?", {
              replyMarkup: keyboard,
            });
          }
        } catch (error) {
          logError("callback: ask-user answer failed", error, {
            chatId,
            userId,
            username,
            session: sctx?.sessionName,
            topic: threadId,
            requestId,
          });
          await busReply(ctx, `❌ Error: ${String(error).slice(0, 200)}`);
        } finally {
          typing.stop();
        }
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: "Unknown action" });
    return;
  }

  // Settings panel callbacks: set:<action>[:<field>[:<value>]]
  if (callbackData.startsWith("set:")) {
    await handleSettingsCallback(ctx, chatId, callbackData, threadId);
    return;
  }

  // /groupmode selector: gm:<on|off|auto>
  if (callbackData.startsWith("gm:")) {
    await handleGroupModeCallback(ctx, callbackData.slice(3));
    return;
  }

  // /tui key panel: tui:<action>:<launchUuid>
  if (callbackData.startsWith("tui:")) {
    await handleTuiCallback(ctx, callbackData);
    return;
  }

  // /tmux panel: tmux:<action>[:<launchUuid>]
  if (callbackData.startsWith("tmux:")) {
    await handleTmuxCallback(ctx, callbackData.slice(5));
    return;
  }

  // /cursor session subscribe: cursorsub:<name>
  if (callbackData.startsWith("cursorsub:")) {
    await handleCursorSubscribe(ctx, callbackData.slice(10));
    return;
  }

  // /cursor selector: cursor:<off>
  if (callbackData.startsWith("cursor:")) {
    await handleCursorBridgeCallback(ctx, callbackData.slice(7));
    return;
  }

  // Ralph loop controls: ralph:deltopic:<loopId> — delete the finished loop's
  // forum topic. The button lives in the topic, so threadId identifies it.
  if (callbackData.startsWith("ralph:deltopic")) {
    if (threadId === undefined) {
      await ctx.answerCallbackQuery({ text: "No topic to delete" });
      return;
    }
    try {
      await ctx.api.deleteForumTopic(chatId, threadId);
      await ctx.answerCallbackQuery({ text: "Topic deleted" });
    } catch (err) {
      warn("ralph: delete topic failed", err, { chatId, topic: threadId });
      await ctx.answerCallbackQuery({
        text: "Couldn't delete — check bot admin rights",
      });
    }
    return;
  }

  // ask_remote (relay-bridge two-way): askremote:{ask_id}:{idx|custom|cancel}
  if (callbackData.startsWith("askremote:")) {
    const queryId = ctx.callbackQuery?.id;
    if (!queryId) {
      await ctx.answerCallbackQuery();
      return;
    }
    const consumed = await handleAskRemoteCallback(
      ctx.api,
      callbackData,
      queryId,
    );
    if (consumed) return;
  }

  // Permission relay: perm:<request_id>:<allow|deny>
  if (callbackData.startsWith("perm:")) {
    const queryId = ctx.callbackQuery?.id;
    if (!queryId) {
      await ctx.answerCallbackQuery();
      return;
    }
    const consumed = await handlePermissionCallback(
      ctx.api,
      callbackData,
      queryId,
    );
    if (consumed) return;
  }

  // AUQ-bridge inline keyboard: bridge:<requestId>:<questionIndex>:<optionIndex|custom>
  if (callbackData.startsWith("bridge:")) {
    const queryId = ctx.callbackQuery?.id;
    if (!queryId) {
      await ctx.answerCallbackQuery();
      return;
    }
    const threadId = ctx.callbackQuery?.message?.message_thread_id;
    const consumed = await handleBridgeCallback(
      ctx.api,
      callbackData,
      queryId,
      chatId,
      threadId,
    );
    if (consumed) return;
  }

  // 6. Parse callback data: askuser:{request_id}:{option_index}
  if (!callbackData.startsWith("askuser:")) {
    await ctx.answerCallbackQuery();
    return;
  }

  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  const optionIndex = parseInt(parts[2]!, 10);

  // Validate requestId before using it in a filesystem path. It is minted
  // as Date.now() (digits only) — anything else is forged or corrupted.
  if (!/^\d+$/.test(requestId)) {
    await ctx.answerCallbackQuery({ text: "Invalid request" });
    return;
  }

  // 7. Load request file
  const requestFile = `/tmp/ask-user-${requestId}.json`;
  let requestData: {
    question: string;
    options: string[];
    status: string;
  };

  try {
    const file = Bun.file(requestFile);
    const text = await file.text();
    requestData = JSON.parse(text);
  } catch (error) {
    logError("callback: failed to load ask-user request", error, {
      chatId,
      session: sctx?.sessionName,
      topic: threadId,
      requestId,
      requestFile,
    });
    await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
    return;
  }

  // 8. Get selected option
  if (optionIndex < 0 || optionIndex >= requestData.options.length) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }

  const selectedOption = requestData.options[optionIndex]!;

  // 9. Update the message to show selection
  try {
    await ctx.editMessageText(`✓ ${selectedOption}`);
  } catch (error) {
    debug("callback: failed to edit confirmation message", {
      chatId,
      requestId,
      err: String(error),
    });
  }

  // 10. Answer the callback
  await ctx.answerCallbackQuery({
    text: `Selected: ${selectedOption.slice(0, 50)}`,
  });

  // 11. Delete request file
  try {
    unlinkSync(requestFile);
  } catch (error) {
    debug("callback: failed to delete request file", {
      requestId,
      requestFile,
      err: String(error),
    });
  }

  // 12. Send the choice to Claude as a message via the originating topic's
  // SessionState. Legacy file-based ask_user callbacks land without
  // SessionContext when invoked from General/DM — in that case there's no
  // session to attribute the answer to.
  const message = selectedOption;
  const legacyState =
    sctx && sctx.source === "cc" ? getSessionState(sctx.sessionName) : null;
  if (!legacyState) {
    await busReply(ctx, "❌ Cannot route answer — no session for this topic.");
    return;
  }

  // Interrupt any running query - button responses are always immediate
  if (legacyState.isRunning) {
    info("callback: interrupting current query for response", {
      chatId,
      userId,
      session: sctx?.sessionName,
      topic: threadId,
      requestId,
    });
    await legacyState.stop();
    // Small delay to ensure clean interruption
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const streamState = new StreamingState();
  const statusCallback = createStatusCallback(ctx, streamState);

  try {
    const response = await runQueryStreaming(legacyState, {
      message,
      username,
      userId,
      statusCallback,
      chatId,
      ctx,
      model: getCurrentModel(),
    });

    await auditLog(userId, username, "CALLBACK", message, response);
  } catch (error) {
    logError("callback: processing failed", error, {
      chatId,
      userId,
      username,
      session: sctx?.sessionName,
      topic: threadId,
      requestId,
    });

    for (const toolMsg of streamState.toolMessages) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch (error) {
        debug("callback: failed to delete tool message", {
          chatId: toolMsg.chat.id,
          messageId: toolMsg.message_id,
          err: String(error),
        });
      }
    }

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
      const wasInterrupt = legacyState.consumeInterruptFlag();
      if (!wasInterrupt) {
        await busReply(ctx, "🛑 Query stopped.");
      }
    } else {
      await busReply(ctx, `❌ Error: ${String(error).slice(0, 200)}`);
    }
  } finally {
    typing.stop();
  }
}

export async function handleSettingsCallback(
  ctx: Context,
  chatId: number,
  data: string,
  threadId?: number,
): Promise<void> {
  const parts = data.split(":");
  const action = parts[1];

  if (action === "edit") {
    const field = parts[2];
    if (field === "terminal") {
      const current = getTerminal();
      const choices: TerminalApp[] = ["terminal", "iterm2", "ghostty", "cmux"];
      const rows = choices.map((c) => [
        {
          text: c === current ? `✓ ${TERMINAL_LABELS[c]}` : TERMINAL_LABELS[c]!,
          callback_data: `set:pick:terminal:${c}`,
        },
      ]);
      rows.push([
        { text: "↺ Reset to default", callback_data: "set:reset:terminal" },
        { text: "← Back", callback_data: "set:back" },
      ]);
      await ctx.editMessageText("🖥 <b>Select terminal:</b>", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: rows },
      });
      await ctx.answerCallbackQuery();
      return;
    }

    if (field === "workdir") {
      pendingSettingsInput.set(pendingKey(chatId, threadId), "workdir");
      await ctx.editMessageText(
        `📁 <b>Reply with absolute path</b> (or <code>/cancel</code>):\n\nCurrent: <code>${escapeHtml(
          getWorkingDir(),
        )}</code>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "↺ Reset to default",
                  callback_data: "set:reset:workdir",
                },
                { text: "← Cancel", callback_data: "set:back" },
              ],
            ],
          },
        },
      );
      await ctx.answerCallbackQuery({ text: "Reply with new path" });
      return;
    }

    if (field === "ralphlabel") {
      pendingSettingsInput.set(pendingKey(chatId, threadId), "ralphlabel");
      const cur = getDefaultRalphLabel();
      await ctx.editMessageText(
        `🏷 <b>Reply with a GitHub label</b> for new /ralph loops (or <code>-</code> for no filter / <code>/cancel</code>):\n\nCurrent: <code>${
          cur ? escapeHtml(cur) : "all issues"
        }</code>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "↺ Reset to default",
                  callback_data: "set:reset:ralphlabel",
                },
                { text: "← Cancel", callback_data: "set:back" },
              ],
            ],
          },
        },
      );
      await ctx.answerCallbackQuery({ text: "Reply with a label" });
      return;
    }

    if (field === "autowatch") {
      // Cycle: default(undefined) → off(false) → on(true) → default
      const current = getOverrides().autoWatchOnSpawn;
      let next: boolean | undefined;
      if (current === undefined) next = false;
      else if (current === false) next = true;
      else next = undefined;
      await saveSetting({ autoWatchOnSpawn: next });
      await rerenderSettingsPanel(ctx);
      const label = next === undefined ? "default (on)" : next ? "on" : "off";
      await ctx.answerCallbackQuery({ text: `Auto-watch: ${label}` });
      return;
    }

    if (field === "pinnedstatus") {
      const current = getOverrides().enablePinnedStatus;
      let next: boolean | undefined;
      if (current === undefined) next = false;
      else if (current === false) next = true;
      else next = undefined;
      await saveSetting({ enablePinnedStatus: next });
      await rerenderSettingsPanel(ctx);
      const label = next === undefined ? "default (on)" : next ? "on" : "off";
      await ctx.answerCallbackQuery({ text: `Pinned Status: ${label}` });
      return;
    }

    if (field === "images") {
      const current = getOverrides().watchImages;
      let next: boolean | undefined;
      if (current === undefined) next = false;
      else if (current === false) next = true;
      else next = undefined;
      await saveSetting({ watchImages: next });
      await rerenderSettingsPanel(ctx);
      const label = next === undefined ? "default (on)" : next ? "on" : "off";
      await ctx.answerCallbackQuery({ text: `Images: ${label}` });
      return;
    }

    if (field === "ralphverbose") {
      const current = getOverrides().ralphVerboseDefault;
      let next: boolean | undefined;
      if (current === undefined) next = true;
      else if (current === true) next = false;
      else next = undefined;
      await saveSetting({ ralphVerboseDefault: next });
      await rerenderSettingsPanel(ctx);
      const label = next === undefined ? "default (off)" : next ? "on" : "off";
      await ctx.answerCallbackQuery({ text: `Ralph verbose: ${label}` });
      return;
    }

    if (field === "verbose") {
      // Cycle normal(default) → detailed → quiet → normal. Level 1 is the
      // default, so it's stored as `undefined` to show the "(default)" marker.
      const order = [0, 1, 2] as const;
      const current = getVerboseLevel();
      const next = order[(order.indexOf(current) + 1) % order.length]!;
      await saveSetting({ verboseLevel: next === 1 ? undefined : next });
      await rerenderSettingsPanel(ctx);
      await ctx.answerCallbackQuery({
        text: `Verbosity: ${VERBOSE_LABELS[next]}${next === 1 ? " (default)" : ""}`,
      });
      return;
    }

    if (field === "contextnotify") {
      const current = getContextNotifyStep();
      const order = [0, 10, 25, 50];
      const idx = order.indexOf(current);
      const nextIdx = idx === -1 ? 1 : (idx + 1) % order.length;
      const next = order[nextIdx]!;
      await saveSetting({
        contextNotifyStep: next === 0 ? undefined : next,
      });
      await rerenderSettingsPanel(ctx);
      const label = next === 0 ? "off" : `every ${next}%`;
      await ctx.answerCallbackQuery({ text: `Context notify: ${label}` });
      return;
    }

    if (field === "model") {
      const current = getCurrentModel();
      const models = Object.entries(MODEL_DISPLAY_NAMES) as [ModelId, string][];
      const rows = models.map(([id, name]) => [
        {
          text: id === current ? `✓ ${name}` : name,
          callback_data: `set:pick:model:${id}`,
        },
      ]);
      rows.push([
        { text: "↺ Reset to default", callback_data: "set:reset:model" },
        { text: "← Back", callback_data: "set:back" },
      ]);
      await ctx.editMessageText(
        `🤖 <b>Model:</b> ${getCurrentModelDisplayName()}`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: rows },
        },
      );
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery({ text: "Unknown field" });
    return;
  }

  if (action === "pick") {
    const field = parts[2];
    const value = parts[3];
    if (!field || !value) {
      await ctx.answerCallbackQuery({ text: "Bad payload" });
      return;
    }
    if (field === "terminal") {
      await saveSetting({ terminal: value as TerminalApp });
      await rerenderSettingsPanel(ctx);
      await ctx.answerCallbackQuery({ text: `Terminal: ${value}` });
      return;
    }
    if (field === "model") {
      // setCurrentModel writes to settings AND updates the running default.
      setCurrentModel(value as ModelId);
      await rerenderSettingsPanel(ctx);
      await ctx.answerCallbackQuery({ text: `Model: ${value}` });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Unknown field" });
    return;
  }

  if (action === "reset") {
    const field = parts[2];
    if (field === "terminal") {
      await saveSetting({ terminal: undefined });
    } else if (field === "workdir") {
      await saveSetting({ workingDir: undefined });
      pendingSettingsInput.delete(pendingKey(chatId, threadId));
    } else if (field === "autowatch") {
      await saveSetting({ autoWatchOnSpawn: undefined });
    } else if (field === "pinnedstatus") {
      await saveSetting({ enablePinnedStatus: undefined });
    } else if (field === "images") {
      await saveSetting({ watchImages: undefined });
    } else if (field === "ralphverbose") {
      await saveSetting({ ralphVerboseDefault: undefined });
    } else if (field === "ralphlabel") {
      await saveSetting({ defaultRalphLabel: undefined });
      pendingSettingsInput.delete(pendingKey(chatId, threadId));
    } else if (field === "contextnotify") {
      await saveSetting({ contextNotifyStep: undefined });
    } else if (field === "verbose") {
      await saveSetting({ verboseLevel: undefined });
    } else if (field === "model") {
      // Clearing the override only affects next restart; the live session
      // keeps whatever model it last had.
      await saveSetting({ defaultModel: undefined });
    } else {
      await ctx.answerCallbackQuery({ text: "Unknown field" });
      return;
    }
    await rerenderSettingsPanel(ctx);
    await ctx.answerCallbackQuery({ text: `Reset ${field}` });
    return;
  }

  if (action === "back") {
    pendingSettingsInput.delete(pendingKey(chatId, threadId));
    await rerenderSettingsPanel(ctx);
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown action" });
}
