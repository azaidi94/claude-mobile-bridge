/**
 * Security module for Claude Telegram Bot.
 *
 * Rate limiting, path validation, command safety.
 */

import { resolve, normalize } from "path";
import { realpathSync } from "fs";
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

  // Check blocked patterns
  for (const pattern of config.BLOCKED_PATTERNS) {
    if (lowerCommand.includes(pattern.toLowerCase())) {
      return [false, `Blocked pattern: ${pattern}`];
    }
  }

  // Special handling for rm commands - validate paths
  if (lowerCommand.includes("rm ")) {
    try {
      // Simple parsing: extract arguments after rm
      const rmMatch = command.match(/rm\s+(.+)/i);
      if (rmMatch) {
        const args = rmMatch[1]!.split(/\s+/);
        for (const arg of args) {
          // Skip flags
          if (arg.startsWith("-") || arg.length <= 1) continue;

          // Check if path is allowed
          if (!isPathAllowed(arg)) {
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

// ============== Authorization ==============

export function isAuthorized(
  userId: number | undefined,
  allowedUsers: number[],
): boolean {
  if (!userId) return false;
  if (allowedUsers.length === 0) return false;
  return allowedUsers.includes(userId);
}
