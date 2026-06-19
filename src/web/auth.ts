import { createHmac, createHash, timingSafeEqual } from "crypto";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { TELEGRAM_TOKEN, ALLOWED_USERS } from "../config";

// Normalises both strings to equal-length SHA-256 digests before comparing
// so callers cannot leak secrets via timing differences.
export function timingSafeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 300,
): boolean {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = params.get("auth_date");
  if (!hash || !authDate) return false;

  if (maxAgeSeconds > 0) {
    const age = Math.floor(Date.now() / 1000) - parseInt(authDate, 10);
    if (age > maxAgeSeconds) return false;
  }

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const expectedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  return timingSafeCompare(expectedHash, hash);
}

export function extractInitData(c: Context): string {
  return c.req.header("X-Telegram-Init-Data") ?? c.req.query("initData") ?? "";
}

function isLoopback(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.")
  );
}

function isPrivateNetwork(addr: string | null | undefined): boolean {
  if (!addr) return false;
  if (isLoopback(addr)) return true;
  const ip = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1] ?? "", 10);
    return second >= 16 && second <= 31;
  }
  return false;
}

export const authMiddleware = createMiddleware(async (c, next) => {
  if (process.env.WEB_AUTH_BYPASS === "true") return next();

  const fwd = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip");
  const remote = (c.env as { remoteAddr?: string | null } | undefined)
    ?.remoteAddr;

  if (process.env.WEB_AUTH_LAN_BYPASS === "true") {
    if (!fwd && isPrivateNetwork(remote ?? null)) return next();
  }

  const initData = extractInitData(c);
  if (!initData) return c.json({ error: "Unauthorized" }, 401);
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!token || !validateInitData(initData, token)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Reject any Telegram user not in the allowlist. An empty allowlist means
  // no one is permitted (startup validation enforces it's non-empty in prod).
  let userId: number | undefined;
  try {
    const params = new URLSearchParams(initData);
    const userJson = params.get("user");
    if (!userJson) return c.json({ error: "Unauthorized" }, 401);
    const parsed = JSON.parse(userJson) as { id?: unknown };
    if (typeof parsed.id !== "number")
      return c.json({ error: "Unauthorized" }, 401);
    userId = parsed.id;
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!ALLOWED_USERS.includes(userId)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return next();
});
