/**
 * Security module for Claude Telegram Bot.
 *
 * Rate limiting, path validation, command safety.
 */

import { resolve, normalize } from "path";
import { realpathSync } from "fs";
import type {
  HookCallback,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type { RateLimitBucket } from "./types";
import * as config from "./config";

// ============== Rate Limiter ==============

class RateLimiter {
  private buckets = new Map<number, RateLimitBucket>();

  // Read config lazily to support test mocking
  private get maxTokens(): number {
    return config.RATE_LIMIT_REQUESTS;
  }

  private get refillRate(): number {
    return config.RATE_LIMIT_REQUESTS / config.RATE_LIMIT_WINDOW;
  }

  check(userId: number): [allowed: boolean, retryAfter?: number] {
    if (!config.RATE_LIMIT_ENABLED) {
      return [true];
    }

    const now = Date.now();
    let bucket = this.buckets.get(userId);

    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastUpdate: now };
      this.buckets.set(userId, bucket);
    }

    // Refill tokens based on time elapsed
    const elapsed = (now - bucket.lastUpdate) / 1000;
    bucket.tokens = Math.min(
      this.maxTokens,
      bucket.tokens + elapsed * this.refillRate,
    );
    bucket.lastUpdate = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return [true];
    }

    // Calculate time until next token
    const retryAfter = (1 - bucket.tokens) / this.refillRate;
    return [false, retryAfter];
  }

  getStatus(userId: number): {
    tokens: number;
    max: number;
    refillRate: number;
  } {
    const bucket = this.buckets.get(userId);
    return {
      tokens: bucket?.tokens ?? this.maxTokens,
      max: this.maxTokens,
      refillRate: this.refillRate,
    };
  }
}

export const rateLimiter = new RateLimiter();

// ============== Path Validation ==============

export function isPathAllowed(path: string): boolean {
  try {
    // Expand ~ and resolve to absolute path
    const expanded = path.replace(/^~/, process.env.HOME || "");
    const normalized = normalize(expanded);

    // Collect all forms of the target path (handles symlinks like /tmp → /private/tmp)
    const targetForms = new Set<string>();
    targetForms.add(resolve(normalized));
    try {
      targetForms.add(realpathSync(normalized));
    } catch {
      // Path may not exist yet
    }

    // Check if target matches a given base path (any form combination)
    const matchesBase = (basePath: string): boolean => {
      const baseForms = new Set<string>();
      baseForms.add(resolve(basePath));
      try {
        baseForms.add(realpathSync(resolve(basePath)));
      } catch {
        // Base path may not exist
      }
      for (const target of targetForms) {
        for (const base of baseForms) {
          if (target === base || target.startsWith(base + "/")) return true;
        }
      }
      return false;
    };

    // Always allow temp paths (for bot's own files)
    for (const tempPath of config.TEMP_PATHS) {
      if (matchesBase(tempPath)) return true;
    }

    // Check against allowed paths using proper containment
    for (const allowed of config.ALLOWED_PATHS) {
      if (matchesBase(allowed)) return true;
    }

    return false;
  } catch {
    return false;
  }
}

// ============== Command Safety ==============

export function checkCommandSafety(
  command: string,
): [safe: boolean, reason: string] {
  const lowerCommand = command.toLowerCase();

  // Check blocked patterns.
  // Patterns ending with '/' or '~' get a word-boundary check after the match
  // to prevent false positives where the pattern is a prefix of a longer path
  // (e.g. "rm -rf /" must not block "rm -rf /tmp/build").
  for (const pattern of config.BLOCKED_PATTERNS) {
    const patternLower = pattern.toLowerCase();
    const idx = lowerCommand.indexOf(patternLower);
    if (idx === -1) continue;
    const lastChar = patternLower[patternLower.length - 1];
    if (lastChar === "/" || lastChar === "~") {
      const charAfter = lowerCommand[idx + patternLower.length];
      // Allow only if the pattern is immediately continued by more path
      // characters. Any shell word terminator — whitespace (incl. tab),
      // separators, redirects, subshell/quote delimiters — ends the word,
      // so the pattern matched a bare target, not a longer-path prefix.
      if (charAfter !== undefined && !/[\s;&|<>()`'"]/.test(charAfter)) {
        continue;
      }
    }
    return [false, `Blocked pattern: ${pattern}`];
  }

  // Special handling for rm commands - validate paths.
  // Use word-boundary detection to avoid false positives like "confirm delete".
  if (/(?:^|[;&|`$(\s])rm\s/.test(command)) {
    try {
      const rmMatch = command.match(/(?:^|[;&|`$(\s])rm\s+(.*)/i);
      if (rmMatch) {
        const args = rmMatch[1]!.split(/\s+/).filter(Boolean);

        // Detect recursive and force flags in any order / combination
        const hasRecursive = args.some(
          (a) =>
            a === "-r" ||
            a === "-R" ||
            a === "--recursive" ||
            /^-[a-zA-Z]*[rR]/.test(a),
        );
        const hasForce = args.some(
          (a) => a === "-f" || a === "--force" || /^-[a-zA-Z]*f/.test(a),
        );

        for (const arg of args) {
          // Skip flags
          if (arg.startsWith("-")) continue;

          // Strip surrounding quotes before path validation
          const stripped = arg.replace(/^["']|["']$/g, "");
          if (!stripped) continue;

          // Catastrophic targets (~, /) must be blocked even if HOME is in
          // ALLOWED_PATHS — rm -rf ~ or rm -rf / deletes the entire tree.
          if (
            hasRecursive &&
            hasForce &&
            (stripped === "/" || stripped === "~")
          ) {
            return [false, `rm target outside allowed paths: ${arg}`];
          }

          if (!isPathAllowed(stripped)) {
            return [false, `rm target outside allowed paths: ${arg}`];
          }
        }
      }
    } catch {
      // If parsing fails, be cautious
      return [false, "Could not parse rm command for safety check"];
    }
  }

  return [true, ""];
}

// ============== PreToolUse Safety Hook ==============

/**
 * PreToolUse hook that enforces command and path safety BEFORE tool execution.
 * Registered with matcher "Bash|Read|Write|Edit" in session options.
 * This is the authoritative enforcement point; stream-side checks remain as
 * defense-in-depth.
 */
export const enforceToolSafety: HookCallback = async (input) => {
  const preInput = input as PreToolUseHookInput;
  const toolName = preInput.tool_name;
  const toolInput = preInput.tool_input as Record<string, unknown>;

  if (toolName === "Bash") {
    const command = String(toolInput.command || "");
    const [isSafe, reason] = checkCommandSafety(command);
    if (!isSafe) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: reason,
        },
      };
    }
  }

  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    const filePath = String(toolInput.file_path || "");
    if (filePath) {
      const isTmpRead =
        toolName === "Read" &&
        (config.TEMP_PATHS.some((p) => filePath.startsWith(p)) ||
          filePath.includes("/.claude/"));

      if (!isTmpRead && !isPathAllowed(filePath)) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: `File access blocked: ${filePath}`,
          },
        };
      }
    }
  }

  return {};
};

// ============== Authorization ==============

export function isAuthorized(
  userId: number | undefined,
  allowedUsers: number[],
): boolean {
  if (!userId) return false;
  if (allowedUsers.length === 0) return false;
  return allowedUsers.includes(userId);
}
