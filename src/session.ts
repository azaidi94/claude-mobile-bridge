/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession class manages Claude Code sessions using the Agent SDK V1.
 * V1 supports full options (cwd, mcpServers, settingSources, etc.)
 */

import { readFileSync } from "fs";
import {
  query,
  type Options,
  type SDKMessage,
  type HookCallback,
  type PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "grammy";
import {
  ALLOWED_PATHS,
  MCP_SERVERS,
  SAFETY_PROMPT,
  STREAMING_THROTTLE_MS,
  TEMP_PATHS,
  THINKING_DEEP_KEYWORDS,
  THINKING_KEYWORDS,
} from "./config";
import { getDefaultModelSetting, saveSetting } from "./settings";
import { formatToolStatus } from "./formatting";
import {
  checkPendingAskUserRequests,
  checkPendingAskUserQuestionRequests,
} from "./handlers/streaming";
import {
  checkCommandSafety,
  enforceToolSafety,
  isPathAllowed,
} from "./security";
import type { StatusCallback, TokenUsage, AskUserQuestionInput } from "./types";
import { updateSessionId } from "./sessions";
import { SessionState } from "./sessions/session-state";
import { globalEventBus } from "./web/sse";
import { createOpId, elapsedMs, info, warn, error, debug } from "./logger";

export interface RequestTelemetry {
  opId?: string;
  requestKind?: string;
}

// ============== File Send Directive Helpers ==============

/** Extract <<SEND_FILE:path>> directives from text, returning matched paths. */
function extractFileDirectives(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(/<<SEND_FILE:(.+?)>>/g)) {
    paths.push(match[1]!);
  }
  return paths;
}

/** Strip <<SEND_FILE:path>> directives from text for display. */
function stripFileDirectives(text: string): string {
  return text.replace(/<<SEND_FILE:.+?>>\n?/g, "");
}

/**
 * Determine thinking token budget based on message keywords.
 */
function getThinkingLevel(message: string): number {
  const msgLower = message.toLowerCase();

  // Check deep thinking triggers first (more specific)
  if (THINKING_DEEP_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 50000;
  }

  // Check normal thinking triggers
  if (THINKING_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 10000;
  }

  // Default: no thinking
  return 0;
}

/**
 * Hook to auto-approve WebSearch and WebFetch tools.
 * These tools have a known issue where they prompt for permission
 * even with allowDangerouslySkipPermissions enabled.
 *
 * TODO: Remove this workaround when the Claude Agent SDK properly respects
 * allowDangerouslySkipPermissions for WebSearch/WebFetch tools.
 * See: https://github.com/anthropics/claude-code/issues/11881
 */
export const autoApproveWebTools: HookCallback = async (input) => {
  const preInput = input as PreToolUseHookInput;
  if (preInput.tool_name === "WebSearch" || preInput.tool_name === "WebFetch") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "allow" as const,
        permissionDecisionReason: "Auto-approved for Telegram bot",
      },
    };
  }
  return {};
};

/**
 * Extract text content from SDK message.
 */
function getTextFromMessage(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;

  const textParts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    }
  }
  return textParts.length > 0 ? textParts.join("") : null;
}

/**
 * Model identifiers accepted from the /model picker, CLAUDE_MODEL env var,
 * and ~/.claude/settings.json. Short aliases map to display labels via
 * MODEL_DISPLAY_NAMES; full Anthropic IDs pass through to the CLI as-is.
 */
type ShortModelId = "opus" | "sonnet" | "haiku";
export type ModelId = ShortModelId | `claude-${string}`;

export const MODEL_DISPLAY_NAMES = {
  opus: "Opus 4.6",
  sonnet: "Sonnet 4.6",
  haiku: "Haiku 4.5",
} as const satisfies Record<ShortModelId, string>;

/** Safe display name for any ModelId — short alias or full claude-* ID. */
export function getModelDisplayName(m: ModelId): string {
  return m in MODEL_DISPLAY_NAMES ? MODEL_DISPLAY_NAMES[m as ShortModelId] : m;
}

function readClaudeSettingsModel(): ModelId | undefined {
  try {
    const settingsPath = `${process.env.HOME}/.claude/settings.json`;
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as { model?: string };
    const m = parsed.model;
    if (!m) return undefined;
    // Accept short aliases (opus/sonnet/haiku) and full model IDs
    if (m in MODEL_DISPLAY_NAMES) return m as ModelId;
    // Full ID like "claude-sonnet-4-6" — accepted even if not in display map
    if (m.startsWith("claude-")) return m as ModelId;
    warn(
      `settings: unrecognised model "${m}" in ~/.claude/settings.json, ignoring`,
    );
  } catch {
    // settings file missing or unreadable — not an error
  }
  return undefined;
}

function isAcceptableModelId(m: string): boolean {
  return m in MODEL_DISPLAY_NAMES || m.startsWith("claude-");
}

const envModel = process.env.CLAUDE_MODEL?.trim() || undefined;
const settingsModel = getDefaultModelSetting();

function pickAcceptableModel(m: string | undefined): ModelId | undefined {
  if (m && isAcceptableModelId(m)) return m as ModelId;
  return undefined;
}

const DEFAULT_MODEL: ModelId =
  pickAcceptableModel(settingsModel) ??
  pickAcceptableModel(envModel) ??
  readClaudeSettingsModel() ??
  "opus";

// ============== Global model state ==============
//
// Per phase 1 R3(a): the model selection is process-global in v1. The
// per-session containers (SessionState) carry per-session fields; the model
// lives here as a tiny free-function API.
let _currentModel: ModelId = DEFAULT_MODEL;

export function getCurrentModel(): ModelId {
  return _currentModel;
}

export function getCurrentModelDisplayName(): string {
  return getModelDisplayName(_currentModel);
}

/**
 * Update the process-global model. `persist` defaults to true — writes the
 * choice to settings.json so it survives restarts.
 */
export function setCurrentModel(model: ModelId, persist = true): void {
  _currentModel = model;
  info(`model: ${model}`);
  if (persist) {
    saveSetting({ defaultModel: model }).catch(() => {
      // non-fatal; runtime already updated
    });
  }
}

// ============== Stateless streaming wrappers ==============

/**
 * Run a Claude query against a SessionState. Stateless w.r.t. the singleton —
 * every read/write touches the passed-in `state`. The streaming callback
 * closures capture `state`, so two queries against different SessionStates
 * cannot stomp on each other.
 *
 * NOTE: `process.env.TELEGRAM_CHAT_ID = String(chatId)` remains a process-global
 * side effect (consumed by the ask_user MCP server). Flagged for phase 4/5
 * cleanup — for v1 only one query runs at a time per Telegram bot so the
 * collision risk is theoretical.
 */
export async function runQueryStreaming(
  state: SessionState,
  opts: {
    message: string;
    username: string;
    userId: number;
    statusCallback: StatusCallback;
    chatId?: number;
    ctx?: Context;
    permissionMode?: "bypassPermissions" | "plan";
    telemetry?: RequestTelemetry;
    model: ModelId;
  },
): Promise<string> {
  const {
    message,
    username,
    userId,
    statusCallback,
    chatId,
    ctx,
    permissionMode = "bypassPermissions",
    telemetry = {},
    model,
  } = opts;

  const opId = telemetry.opId || createOpId("claude");
  const requestKind =
    telemetry.requestKind || (permissionMode === "plan" ? "plan" : "message");
  const requestStartedAt = Date.now();
  let completionState = "completed";

  const requestFields = () => ({
    opId,
    requestKind,
    chatId,
    userId,
    username,
    sessionId: state.sessionId,
    sessionName: state.sessionName,
    cwd: state.workingDir,
    model,
    permissionMode,
  });

  info("claude: request started", {
    ...requestFields(),
    messagePreview: message.slice(0, 120),
  });

  // Set chat context for ask_user MCP tool. Process-global side effect; flagged
  // for phase 4/5 cleanup (ask_user MCP server reads via env).
  if (chatId) {
    process.env.TELEGRAM_CHAT_ID = String(chatId);
  }

  const isNewSession = !state.isActive;
  const thinkingTokens = getThinkingLevel(message);

  // Inject current date/time at session start so Claude doesn't need to call a tool for it
  let messageToSend = message;
  if (isNewSession) {
    const now = new Date();
    const datePrefix = `[Current date/time: ${now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    })}]\n\n`;
    messageToSend = datePrefix + message;
  }

  // Build SDK V1 options - supports all features
  const options: Options = {
    model,
    cwd: state.workingDir,
    settingSources: ["user", "project"],
    permissionMode: permissionMode,
    allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
    systemPrompt: SAFETY_PROMPT,
    mcpServers: MCP_SERVERS,
    maxThinkingTokens: thinkingTokens,
    additionalDirectories: ALLOWED_PATHS,
    resume: state.sessionId || undefined,
    // Hook to auto-approve WebSearch/WebFetch (workaround for known permission bug)
    hooks: {
      PreToolUse: [
        { matcher: "WebSearch|WebFetch", hooks: [autoApproveWebTools] },
        { matcher: "Bash|Read|Write|Edit", hooks: [enforceToolSafety] },
      ],
    },
  };

  // Track plan mode. Mode changes are broadcast on the global event bus
  // keyed by sessionName so infra wireups (pinned-status updater in
  // index.ts, SSE subscribers in web/) can react without a direct callback.
  const wasPlanMode = state.isPlanMode;
  state.isPlanMode = permissionMode === "plan";
  if (state.isPlanMode !== wasPlanMode && state.sessionName) {
    globalEventBus.emit(state.sessionName, {
      type: "mode_change",
      content: "",
      isPlanMode: state.isPlanMode,
    });
  }

  // Add Claude Code executable path if set (required for standalone builds)
  if (process.env.CLAUDE_CODE_PATH) {
    options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
  }

  if (state.sessionId && !isNewSession) {
    info(
      `[${model}] resume ${state.sessionName || state.sessionId.slice(0, 8)}`,
    );
  } else {
    info(`[${model}] new session`);
    state.sessionId = null;
  }

  // Check if stop was requested during processing phase
  if (state.stopRequested) {
    debug("query cancelled before starting");
    state.stopRequested = false;
    throw new Error("Query cancelled");
  }

  // Create abort controller for cancellation
  state.abortController = new AbortController();
  state.isQueryRunning = true;
  state.stopRequested = false;
  state.queryStarted = new Date();
  state.currentTool = null;

  // Response tracking
  const responseParts: string[] = [];
  const filesToSend: string[] = [];
  let currentSegmentId = 0;
  let currentSegmentText = "";
  let lastTextUpdate = 0;
  let queryCompleted = false;
  let askUserTriggered = false;
  let askUserQuestionTriggered = false;
  let askUserQuestionInput: AskUserQuestionInput | null = null;
  let askUserQuestionToolUseId: string | null = null;
  let exitPlanModeTriggered = false;
  let exitPlanToolUseId: string | null = null;
  let lastPlanFilePath: string | null = null;

  try {
    // Use V1 query() API - supports all options including cwd, mcpServers, etc.
    const queryInstance = query({
      prompt: messageToSend,
      options: {
        ...options,
        abortController: state.abortController,
      },
    });

    // Process streaming response
    for await (const event of queryInstance) {
      // Check for abort
      if (state.stopRequested) {
        debug("query aborted");
        break;
      }

      // Capture session_id from first message
      if (!state.sessionId && event.session_id) {
        state.sessionId = event.session_id;
        debug(`session_id: ${state.sessionId!.slice(0, 8)}`);

        // Update watcher cache with the new session ID
        if (state.sessionName) {
          updateSessionId(state.sessionName, state.sessionId);
        }
      }

      // Handle local command output (slash commands like /cost, /compact)
      if (event.type === "user" && event.message?.content) {
        const content = String(event.message.content);
        const match = content.match(
          /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/,
        );
        if (match?.[1]) {
          const cmdOutput = match[1].trim();
          debug(`cmd output: ${cmdOutput.slice(0, 80)}`);
          if (cmdOutput) {
            responseParts.push(cmdOutput);
            await statusCallback("text", cmdOutput, currentSegmentId);
          }
        }
      }

      // Handle different message types
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          // Thinking blocks
          if (block.type === "thinking") {
            const thinkingText = block.thinking;
            if (thinkingText) {
              await statusCallback("thinking", thinkingText);
            }
          }

          // Tool use blocks
          if (block.type === "tool_use") {
            const toolName = block.name;
            const toolInput = block.input as Record<string, unknown>;

            // Stream-side safety checks are report-only: the PreToolUse hook
            // (enforceToolSafety) is the authoritative enforcement point and
            // has already denied the call before execution. The assistant
            // event carrying the tool_use block still streams through here,
            // so notify the user — but don't abort the query over a tool
            // that never ran (the thrown error isn't a cleanup error, so it
            // used to set lastError and leave the session needing /retry).
            if (toolName === "Bash") {
              const command = String(toolInput.command || "");
              const [isSafe, reason] = checkCommandSafety(command);
              if (!isSafe) {
                warn(`blocked: ${reason}`);
                await statusCallback("tool", `BLOCKED: ${reason}`);
                continue;
              }
            }

            if (["Read", "Write", "Edit"].includes(toolName)) {
              const filePath = String(toolInput.file_path || "");
              if (filePath) {
                // Allow reads from temp paths and .claude directories
                const isTmpRead =
                  toolName === "Read" &&
                  (TEMP_PATHS.some((p) => filePath.startsWith(p)) ||
                    filePath.includes("/.claude/"));

                if (!isTmpRead && !isPathAllowed(filePath)) {
                  warn(`blocked: path ${filePath}`);
                  await statusCallback("tool", `Access denied: ${filePath}`);
                  continue;
                }
              }
            }

            // Segment ends when tool starts — extract directives from accumulated text
            if (currentSegmentText) {
              filesToSend.push(...extractFileDirectives(currentSegmentText));
              await statusCallback(
                "segment_end",
                stripFileDirectives(currentSegmentText),
                currentSegmentId,
              );
              currentSegmentId++;
              currentSegmentText = "";
            }

            // Format and show tool status
            const toolDisplay = formatToolStatus(toolName, toolInput);
            state.currentTool = toolDisplay;
            state.lastTool = toolDisplay;
            info(`tool: ${toolDisplay}`);

            // Don't show tool status for ask_user or TodoWrite (reduces noise)
            if (
              !toolName.startsWith("mcp__ask-user") &&
              toolName !== "TodoWrite"
            ) {
              await statusCallback("tool", toolDisplay, undefined, {
                toolName,
                toolInput,
              });
            }

            // Check for pending ask_user requests after ask-user MCP tool
            if (toolName.startsWith("mcp__ask-user") && ctx && chatId) {
              // Small delay to let MCP server write the file
              await new Promise((resolve) => setTimeout(resolve, 200));

              // Retry a few times in case of timing issues
              for (let attempt = 0; attempt < 3; attempt++) {
                const buttonsSent = await checkPendingAskUserRequests(
                  ctx,
                  chatId,
                );
                if (buttonsSent) {
                  askUserTriggered = true;
                  break;
                }
                if (attempt < 2) {
                  await new Promise((resolve) => setTimeout(resolve, 100));
                }
              }
            }

            // Detect ExitPlanMode tool - Claude is done planning
            if (toolName === "ExitPlanMode") {
              exitPlanModeTriggered = true;
              exitPlanToolUseId = block.id;
              debug(`ExitPlanMode: ${block.id}`);
            }

            // Detect AskUserQuestion tool - Claude wants user input
            if (toolName === "AskUserQuestion") {
              askUserQuestionTriggered = true;
              askUserQuestionInput =
                toolInput as unknown as AskUserQuestionInput;
              askUserQuestionToolUseId = block.id;
              debug(`AskUserQuestion: ${block.id}`);
            }

            // Track Write/Edit operations to plan files (for showing plan content later)
            if (
              (toolName === "Write" || toolName === "Edit") &&
              state.isPlanMode
            ) {
              const filePath = String(toolInput.file_path || "");
              if (filePath.endsWith(".md") || filePath.includes("plan")) {
                lastPlanFilePath = filePath;
                debug(`plan file: ${filePath}`);
              }
            }
          }

          // Text content — accumulate raw, strip directives only for display.
          // Directive extraction happens at segment boundaries to handle
          // directives split across streaming chunks.
          if (block.type === "text") {
            responseParts.push(block.text);
            currentSegmentText += block.text;

            // Stream text updates (throttled) — strip directives for display
            const now = Date.now();
            if (
              now - lastTextUpdate > STREAMING_THROTTLE_MS &&
              currentSegmentText.length > 20
            ) {
              await statusCallback(
                "text",
                stripFileDirectives(currentSegmentText),
                currentSegmentId,
              );
              lastTextUpdate = now;
            }
          }
        }

        // Break out of event loop if ask_user, askUserQuestion, or exitPlanMode was triggered
        if (
          askUserTriggered ||
          askUserQuestionTriggered ||
          exitPlanModeTriggered
        ) {
          break;
        }
      }

      // Result message
      if (event.type === "result") {
        queryCompleted = true;

        // Capture usage if available
        if ("usage" in event && event.usage) {
          state.lastUsage = event.usage as TokenUsage;
        }
      }
    }

    // V1 query completes automatically when the generator ends
  } catch (err) {
    const errorStr = String(err).toLowerCase();
    const isCleanupError =
      errorStr.includes("cancel") || errorStr.includes("abort");

    if (
      isCleanupError &&
      (queryCompleted ||
        askUserTriggered ||
        askUserQuestionTriggered ||
        state.stopRequested ||
        state.abortController?.signal.aborted)
    ) {
      if (state.stopRequested && !queryCompleted) {
        completionState = "cancelled";
      }
      debug(`suppressed: ${err}`);
    } else {
      error("claude: request failed", err, {
        ...requestFields(),
        durationMs: elapsedMs(requestStartedAt),
        queryCompleted,
        askUserTriggered,
        askUserQuestionTriggered,
        stopRequested: state.stopRequested,
      });
      state.lastError = String(err).slice(0, 100);
      state.lastErrorTime = new Date();
      throw err;
    }
  } finally {
    state.isQueryRunning = false;
    state.abortController = null;
    state.queryStarted = null;
    state.currentTool = null;
  }

  state.lastActivity = new Date();
  state.lastError = null;
  state.lastErrorTime = null;

  // If ask_user was triggered, return early - user will respond via button
  if (askUserTriggered) {
    completionState = "awaiting_user_selection";
    await statusCallback("done", "");
    info("claude: request completed", {
      ...requestFields(),
      durationMs: elapsedMs(requestStartedAt),
      completionState,
    });
    return "[Waiting for user selection]";
  }

  // If AskUserQuestion was triggered, send buttons and return
  if (
    askUserQuestionTriggered &&
    askUserQuestionInput &&
    askUserQuestionToolUseId &&
    ctx &&
    chatId
  ) {
    const buttonsSent = await checkPendingAskUserQuestionRequests(
      ctx,
      chatId,
      askUserQuestionInput,
      askUserQuestionToolUseId,
      state.isPlanMode,
    );
    if (buttonsSent) {
      completionState = "awaiting_user_selection";
      await statusCallback("done", "");
      info("claude: request completed", {
        ...requestFields(),
        durationMs: elapsedMs(requestStartedAt),
        completionState,
      });
      return "[Waiting for user selection]";
    }
  }

  // If ExitPlanMode was triggered, store approval state and return
  if (exitPlanModeTriggered && exitPlanToolUseId) {
    // Try to read plan file content
    let planContent = "";
    if (lastPlanFilePath) {
      try {
        const file = Bun.file(lastPlanFilePath);
        planContent = await file.text();
        debug(`plan: ${planContent.length} chars`);
      } catch (err) {
        warn(`plan read: ${err}`);
      }
    }

    state.pendingPlanApproval = {
      toolUseId: exitPlanToolUseId,
      planSummary: responseParts.join("").slice(0, 500),
      planContent,
      timestamp: Date.now(),
    };
    completionState = "plan_ready";
    await statusCallback("done", "");
    info("claude: request completed", {
      ...requestFields(),
      durationMs: elapsedMs(requestStartedAt),
      completionState,
    });
    return "[Plan ready for approval]";
  }

  // Emit final segment — extract directives from accumulated text
  if (currentSegmentText) {
    filesToSend.push(...extractFileDirectives(currentSegmentText));
    await statusCallback(
      "segment_end",
      stripFileDirectives(currentSegmentText),
      currentSegmentId,
    );
  }

  // Send any requested files to Telegram (deduplicated)
  for (const filePath of new Set(filesToSend)) {
    await statusCallback("send_file", filePath);
  }

  await statusCallback("done", "");
  const finalResponse =
    stripFileDirectives(responseParts.join("")) || "No response from Claude.";
  info("claude: request completed", {
    ...requestFields(),
    durationMs: elapsedMs(requestStartedAt),
    completionState,
    responseLength: finalResponse.length,
    usageInputTokens: state.lastUsage?.input_tokens,
    usageOutputTokens: state.lastUsage?.output_tokens,
  });
  return finalResponse;
}

/**
 * Stateless plan-approval responder. Consumes `state.pendingPlanApproval`,
 * builds the next prompt, and re-enters `runQueryStreaming` against the same
 * state.
 */
export async function runPlanApproval(
  state: SessionState,
  opts: {
    action: "accept" | "reject" | "edit";
    feedback: string;
    username: string;
    userId: number;
    statusCallback: StatusCallback;
    chatId?: number;
    ctx?: Context;
    telemetry?: RequestTelemetry;
    model: ModelId;
  },
): Promise<string> {
  const {
    action,
    feedback,
    username,
    userId,
    statusCallback,
    chatId,
    ctx,
    telemetry = {},
    model,
  } = opts;

  if (!state.pendingPlanApproval) {
    throw new Error("No pending plan approval");
  }

  state.clearPendingPlanApproval();

  // Determine next permission mode
  const nextPermissionMode: "bypassPermissions" | "plan" =
    action === "accept" ? "bypassPermissions" : "plan";

  // Build approval message
  let message: string;
  if (action === "accept") {
    message = "Plan approved. Proceed with implementation.";
    const wasPlanMode = state.isPlanMode;
    state.isPlanMode = false;
    if (wasPlanMode && state.sessionName) {
      globalEventBus.emit(state.sessionName, {
        type: "mode_change",
        content: "",
        isPlanMode: false,
      });
    }
  } else if (action === "reject") {
    message = `Plan rejected. ${feedback || "Please revise the plan."}`;
  } else {
    message = `Feedback on plan: ${feedback}`;
  }

  info(`plan ${action}`);

  return runQueryStreaming(state, {
    message,
    username,
    userId,
    statusCallback,
    chatId,
    ctx,
    permissionMode: nextPermissionMode,
    telemetry: {
      opId: telemetry.opId,
      requestKind: telemetry.requestKind || `plan_${action}`,
    },
    model,
  });
}
