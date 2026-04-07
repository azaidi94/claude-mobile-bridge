import type { Context } from "grammy";
import { ALLOWED_USERS } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { error as logError } from "../logger";
import { readKeychainToken } from "../lib/keychain";

interface UsageResponse {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
}

// Anthropic's usage endpoint rate-limits aggressively — cache for 60s
// so repeated /usage taps don't hammer it and trip a 429.
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
let cached: { at: number; data: UsageResponse } | null = null;

export function _resetUsageCache(): void {
  cached = null;
}

function formatResetIn(isoTs: string | undefined): string {
  if (!isoTs) return "?";
  const ts = Date.parse(isoTs);
  if (Number.isNaN(ts)) return "?";
  const secs = Math.max(0, Math.floor((ts - Date.now()) / 1000));
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function bar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round(clamped / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function formatWindow(
  label: string,
  pct: number | undefined,
  resetsAt: string | undefined,
): string[] {
  if (typeof pct !== "number" || Number.isNaN(pct)) {
    return [`${label}  (no data)`];
  }
  return [
    `${label}  ${bar(pct)}  ${pct.toFixed(1)}%`,
    `└ resets in ${formatResetIn(resetsAt)}`,
  ];
}

export async function handleUsage(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const [allowed, retryAfter] = rateLimiter.check(userId!);
  if (!allowed) {
    await ctx.reply(`⏳ Rate limited. Wait ${retryAfter!.toFixed(1)}s.`);
    return;
  }

  let data: UsageResponse;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    data = cached.data;
  } else {
    const token = await readKeychainToken();
    if (!token) {
      await ctx.reply("❌ Could not read Claude credentials from keychain.");
      return;
    }

    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      logError("usage: fetch failed", err);
      await ctx.reply("❌ Usage API request failed.");
      return;
    }

    if (res.status === 429) {
      await res.body?.cancel();
      await ctx.reply(
        "⏳ Anthropic usage API is rate-limiting us. Try again in a minute.",
      );
      return;
    }

    if (!res.ok) {
      await res.body?.cancel();
      await ctx.reply(`❌ Usage API returned ${res.status}.`);
      return;
    }

    try {
      data = (await res.json()) as UsageResponse;
    } catch {
      await ctx.reply("❌ Could not parse usage response.");
      return;
    }
    cached = { at: Date.now(), data };
  }

  const lines = [
    "📊 <b>Usage</b>",
    "",
    "<pre>",
    ...formatWindow(
      "Session (5h)",
      data.five_hour?.utilization,
      data.five_hour?.resets_at,
    ),
    "",
    ...formatWindow(
      "Weekly (7d) ",
      data.seven_day?.utilization,
      data.seven_day?.resets_at,
    ),
    "</pre>",
  ];

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}
