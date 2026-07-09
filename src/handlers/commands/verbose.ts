/**
 * /verbose - Control how much session activity streams to Telegram.
 *   0 quiet    — final text only (tool/thinking/result cards suppressed)
 *   1 normal   — full stream (default)
 *   2 detailed — reserved (currently == normal)
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { getVerboseLevel, saveSetting } from "../../settings";
import { isAuthorized } from "../../security";
import { busReply } from "./helpers";

const LABELS: Record<0 | 1 | 2, string> = {
  0: "0 · quiet (final text only)",
  1: "1 · normal (full stream)",
  2: "2 · detailed (reserved — currently == normal)",
};

/** Parse a /verbose argument to a level, or null if invalid. */
export function parseVerboseLevel(arg: string): 0 | 1 | 2 | null {
  const t = arg.trim();
  if (t === "0" || t === "quiet") return 0;
  if (t === "1" || t === "normal") return 1;
  if (t === "2" || t === "detailed") return 2;
  return null;
}

export async function handleVerbose(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx.from?.id, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  const arg = (ctx.message?.text || "").split(/\s+/).slice(1).join(" ").trim();

  if (arg) {
    const level = parseVerboseLevel(arg);
    if (level === null) {
      await busReply(
        ctx,
        "❌ Usage: /verbose [0|1|2]  (0 quiet · 1 normal · 2 detailed)",
      );
      return;
    }
    await saveSetting({ verboseLevel: level });
    await busReply(ctx, `✅ Verbosity: <b>${LABELS[level]}</b>`, "html");
    return;
  }

  const current = getVerboseLevel();
  await busReply(
    ctx,
    `🔊 Verbosity: <b>${LABELS[current]}</b>\n\n<code>/verbose 0</code> quiet · <code>/verbose 1</code> normal · <code>/verbose 2</code> detailed`,
    "html",
  );
}
