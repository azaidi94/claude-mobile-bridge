/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession class manages Claude Code sessions using the Agent SDK V1.
 * V1 supports full options (cwd, mcpServers, settingSources, etc.)
 */

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
  SESSION_FILE,
  STREAMING_THROTTLE_MS,
  TEMP_PATHS,
  THINKING_DEEP_KEYWORDS,
  THINKING_KEYWORDS,
  WORKING_DIR,
} from "./config";
import { formatToolStatus } from "./formatting";
import {
  checkPendingAskUserRequests,
  checkPendingAskUserQuestionRequests,
} from "./handlers/streaming";
import { checkCommandSafety, isPathAllowed } from "./security";
import type {
  SessionData,
  StatusCallback,
  TokenUsage,
  PlanApprovalState,
  AskUserQuestionInput,
} from "./types";
import type { SessionInfo } from "./sessions/types";
import { updateSessionId, updateSessionActivity } from "./sessions";
import { info, warn, error, debug } from "./logger";

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
 * Manages Claude Code sessions using the Agent SDK V1.
 */
// Available models
export type ModelId = "claude-opus-4-6" | "opus" | "sonnet" | "haiku";

export const MODEL_DISPLAY_NAMES: Record<ModelId, string> = {
  "claude-opus-4-6": "Opus 4.6",
  opus: "Opus 4.5",
  sonnet: "Sonnet 4.5",
  haiku: "Haiku 4.5",
};

const DEFAULT_MODEL: ModelId = "claude-opus-4-6";

class ClaudeSession {
  sessionId: string | null = null;
  lastActivity: Date | null = null;
  queryStarted: Date | null = null;
  currentTool: string | null = null;
  lastTool: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;
  lastMessage: string | null = null;

  // Model selection
  private _model: ModelId = DEFAULT_MODEL;

  // Multi-session support
  private _workingDir: string = WORKING_DIR;
  private _sessionName: string | null = null;

  private abortController: AbortController | null = null;
  private isQueryRunning = false;
  private stopRequested = false;
  private _isProcessing = false;
  private _wasInterruptedByNewMessage = false;

  // Plan mode state
  private _isPlanMode = false;
  private _pendingPlanApproval: PlanApprovalState | null = null;

  // Mode change callback
  onModeChange?: (isPlanMode: boolean) => void;

  get workingDir(): string {
    return this._workingDir;
  }

  get sessionName(): string | null {
    return this._sessionName;
  }

  get model(): ModelId {
    return this._model;
  }

  get modelDisplayName(): string {
    return MODEL_DISPLAY_NAMES[this._model];
  }

  setModel(model: ModelId): void {
    this._model = model;
    info(`model: ${model}`);
  }

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    return this.isQueryRunning || this._isProcessing;
  }

  get isPlanMode(): boolean {
    return this._isPlanMode;
  }

  get pendingPlanApproval(): PlanApprovalState | null {
    return this._pendingPlanApproval;
  }

  /**
   * Check if the last stop was triggered by a new message interrupt (! prefix).
   * Resets the flag when called. Also clears stopRequested so new messages can proceed.
   */
  consumeInterruptFlag(): boolean {
    const was = this._wasInterruptedByNewMessage;
    this._wasInterruptedByNewMessage = false;
    if (was) {
      // Clear stopRequested so the new message can proceed
      this.stopRequested = false;
    }
    return was;
  }

  /**
   * Mark that this stop is from a new message interrupt.
   */
  markInterrupt(): void {
    this._wasInterruptedByNewMessage = true;
  }

  /**
   * Clear the stopRequested flag (used after interrupt to allow new message to proceed).
   */
  clearStopRequested(): void {
    this.stopRequested = false;
  }

  /**
   * Mark processing as started.
   * Returns a cleanup function to call when done.
   */
  startProcessing(): () => void {
    this._isProcessing = true;
    return () => {
      this._isProcessing = false;
    };
  }

  /**
   * Stop the currently running query or mark for cancellation.
   * Returns: "stopped" if query was aborted, "pending" if processing will be cancelled, false if nothing running
   */
  async stop(): Promise<"stopped" | "pending" | false> {
    // If a query is actively running, abort it
    if (this.isQueryRunning && this.abortController) {
      this.stopRequested = true;
      this.abortController.abort();
      debug("stop: aborting query");
      return "stopped";
    }

    // If processing but query not started yet
    if (this._isProcessing) {
      this.stopRequested = true;
      debug("stop: will cancel before query starts");
      return "pending";
    }

    return false;
  }

  /**
   * Send a message to Claude with streaming updates via callback.
   *
   * @param ctx - grammY context for ask_user button display
   * @param permissionMode - SDK permission mode (bypassPermissions or plan)
   */
  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context,
    permissionMode: "bypassPermissions" | "plan" = "bypassPermissions",
  ): Promise<string> {
    // Set chat context for ask_user MCP tool
    if (chatId) {
      process.env.TELEGRAM_CHAT_ID = String(chatId);
    }

    const isNewSession = !this.isActive;
    const thinkingTokens = getThinkingLevel(message);
    const thinkingLabel =
      { 0: "off", 10000: "normal", 50000: "deep" }[thinkingTokens] ||
      String(thinkingTokens);

    // Inject current date/time at session start so Claude doesn't need to call a tool for it
    let messageToSend = message;
    if (isNewSession) {
      const now = new Date();
      const datePrefix = `[Current date/time: ${now.toLocaleDateString(
        "en-US",
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        },
      )}]\n\n`;
      messageToSend = datePrefix + message;
    }

    // Build SDK V1 options - supports all features
    const options: Options = {
      model: this._model,
      cwd: this._workingDir,
      settingSources: ["user", "project"],
      permissionMode: permissionMode,
      allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
      systemPrompt: SAFETY_PROMPT,
      mcpServers: MCP_SERVERS,
      maxThinkingTokens: thinkingTokens,
      additionalDirectories: ALLOWED_PATHS,
      resume: this.sessionId || undefined,
      // Hook to auto-approve WebSearch/WebFetch (workaround for known permission bug)
      hooks: {
        PreToolUse: [
          { matcher: "WebSearch|WebFetch", hooks: [autoApproveWebTools] },
        ],
      },
    };

    // Track plan mode
    const wasPlanMode = this._isPlanMode;
    this._isPlanMode = permissionMode === "plan";
    if (this._isPlanMode !== wasPlanMode) {
      this.onModeChange?.(this._isPlanMode);
    }

    // Add Claude Code executable path if set (required for standalone builds)
    if (process.env.CLAUDE_CODE_PATH) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
    }

    if (this.sessionId && !isNewSession) {
      info(
        `[${this._model}] resume ${this._sessionName || this.sessionId.slice(0, 8)}`,
      );
    } else {
      info(`[${this._model}] new session`);
      this.sessionId = null;
    }

    // Check if stop was requested during processing phase
    if (this.stopRequested) {
      debug("query cancelled before starting");
      this.stopRequested = false;
      throw new Error("Query cancelled");
    }

    // Create abort controller for cancellation
    this.abortController = new AbortController();
    this.isQueryRunning = true;
    this.stopRequested = false;
    this.queryStarted = new Date();
    this.currentTool = null;

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
          abortController: this.abortController,
        },
      });

      // Process streaming response
      for await (const event of queryInstance) {
        // Check for abort
        if (this.stopRequested) {
          debug("query aborted");
          break;
        }

        // Capture session_id from first message
        if (!this.sessionId && event.session_id) {
          this.sessionId = event.session_id;
          debug(`session_id: ${this.sessionId!.slice(0, 8)}`);
          this.saveSession();

          // Update watcher cache with the new session ID
          if (this._sessionName) {
            updateSessionId(this._sessionName, this.sessionId);
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

              // Safety check for Bash commands
              if (toolName === "Bash") {
                const command = String(toolInput.command || "");
                const [isSafe, reason] = checkCommandSafety(command);
                if (!isSafe) {
                  warn(`blocked: ${reason}`);
                  await statusCallback("tool", `BLOCKED: ${reason}`);
                  throw new Error(`Unsafe command blocked: ${reason}`);
                }
              }

              // Safety check for file operations
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
                    throw new Error(`File access blocked: ${filePath}`);
                  }
                }
              }

              // Segment ends when tool starts
              if (currentSegmentText) {
                await statusCallback(
                  "segment_end",
                  currentSegmentText,
                  currentSegmentId,
                );
                currentSegmentId++;
                currentSegmentText = "";
              }

              // Format and show tool status
              const toolDisplay = formatToolStatus(toolName, toolInput);
              this.currentTool = toolDisplay;
              this.lastTool = toolDisplay;
              info(`tool: ${toolDisplay}`);

              // Don't show tool status for ask_user or TodoWrite (reduces noise)
              if (
                !toolName.startsWith("mcp__ask-user") &&
                toolName !== "TodoWrite"
              ) {
                await statusCallback("tool", toolDisplay);
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
                this._isPlanMode
              ) {
                const filePath = String(toolInput.file_path || "");
                if (filePath.endsWith(".md") || filePath.includes("plan")) {
                  lastPlanFilePath = filePath;
                  debug(`plan file: ${filePath}`);
                }
              }
            }

            // Text content
            if (block.type === "text") {
              let text = block.text;

              // Detect and extract file send directives
              const fileSendPattern = /<<SEND_FILE:(.+?)>>\n?/g;
              let fileSendMatch;
              while (
                (fileSendMatch = fileSendPattern.exec(text)) !== null
              ) {
                filesToSend.push(fileSendMatch[1]!);
              }
              // Strip directives from displayed text
              text = text.replace(/<<SEND_FILE:.+?>>\n?/g, "");

              responseParts.push(text);
              currentSegmentText += text;

              // Stream text updates (throttled)
              const now = Date.now();
              if (
                now - lastTextUpdate > STREAMING_THROTTLE_MS &&
                currentSegmentText.length > 20
              ) {
                await statusCallback(
                  "text",
                  currentSegmentText,
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
            this.lastUsage = event.usage as TokenUsage;
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
          this.stopRequested)
      ) {
        debug(`suppressed: ${err}`);
      } else {
        error(`query: ${err}`);
        this.lastError = String(err).slice(0, 100);
        this.lastErrorTime = new Date();
        throw err;
      }
    } finally {
      this.isQueryRunning = false;
      this.abortController = null;
      this.queryStarted = null;
      this.currentTool = null;
    }

    this.lastActivity = new Date();
    this.lastError = null;
    this.lastErrorTime = null;

    // If ask_user was triggered, return early - user will respond via button
    if (askUserTriggered) {
      await statusCallback("done", "");
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
        this._isPlanMode,
      );
      if (buttonsSent) {
        await statusCallback("done", "");
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

      this._pendingPlanApproval = {
        toolUseId: exitPlanToolUseId,
        planSummary: responseParts.join("").slice(0, 500),
        planContent,
        timestamp: Date.now(),
      };
      await statusCallback("done", "");
      return "[Plan ready for approval]";
    }

    // Emit final segment
    if (currentSegmentText) {
      await statusCallback("segment_end", currentSegmentText, currentSegmentId);
    }

    // Send any requested files to Telegram
    for (const filePath of filesToSend) {
      await statusCallback("send_file", filePath);
    }

    await statusCallback("done", "");

    return responseParts.join("") || "No response from Claude.";
  }

  /**
   * Kill the current session (clear session_id).
   */
  async kill(): Promise<void> {
    this.sessionId = null;
    this.lastActivity = null;
    this._sessionName = null;
    this._workingDir = WORKING_DIR;
    info("session cleared");
  }

  /**
   * Clear session ID only (preserves working dir, session name).
   * Used when switching models - starts fresh conversation but keeps context.
   */
  clearSession(): void {
    this.sessionId = null;
    this.lastActivity = null;
    debug("session cleared (model switch)");
  }

  /**
   * Set the working directory for this session.
   */
  setWorkingDir(dir: string): void {
    this._workingDir = dir;
    debug(`cwd: ${dir}`);
  }

  /**
   * Load session state from registry info.
   */
  loadFromRegistry(sessionInfo: SessionInfo): void {
    this.sessionId = sessionInfo.id || null;
    this._sessionName = sessionInfo.name;
    this._workingDir = sessionInfo.dir;
    this.lastActivity = sessionInfo.lastActivity
      ? new Date(sessionInfo.lastActivity)
      : null;
    info(`load: ${sessionInfo.name}`);
  }

  /**
   * Save session to disk for resume after restart.
   */
  private saveSession(): void {
    if (!this.sessionId) return;

    try {
      const data: SessionData = {
        session_id: this.sessionId,
        saved_at: new Date().toISOString(),
        working_dir: this._workingDir,
      };
      Bun.write(SESSION_FILE, JSON.stringify(data));
      debug(`saved: ${SESSION_FILE}`);
    } catch (err) {
      warn(`save failed: ${err}`);
    }
  }

  /**
   * Respond to a pending plan approval.
   *
   * @param action - 'accept', 'reject', or 'edit'
   * @param feedback - User feedback for reject/edit
   * @param statusCallback - Status callback for streaming
   * @param ctx - grammY context
   * @param chatId - Chat ID
   * @returns Response from Claude
   */
  async respondToPlanApproval(
    action: "accept" | "reject" | "edit",
    feedback: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context,
  ): Promise<string> {
    if (!this._pendingPlanApproval) {
      throw new Error("No pending plan approval");
    }

    const { toolUseId } = this._pendingPlanApproval;
    this._pendingPlanApproval = null;

    // Determine next permission mode
    const nextPermissionMode =
      action === "accept" ? "bypassPermissions" : "plan";

    // Build approval message
    let message: string;
    if (action === "accept") {
      message = "Plan approved. Proceed with implementation.";
      this._isPlanMode = false;
      this.onModeChange?.(false);
    } else if (action === "reject") {
      message = `Plan rejected. ${feedback || "Please revise the plan."}`;
    } else {
      message = `Feedback on plan: ${feedback}`;
    }

    info(`plan ${action}`);

    return this.sendMessageStreaming(
      message,
      username,
      userId,
      statusCallback,
      chatId,
      ctx,
      nextPermissionMode,
    );
  }

  /**
   * Clear pending plan approval state.
   */
  clearPendingPlanApproval(): void {
    this._pendingPlanApproval = null;
  }
}

// Global session instance
export const session = new ClaudeSession();
