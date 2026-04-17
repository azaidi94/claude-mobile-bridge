import { createHmac } from "crypto";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { TELEGRAM_TOKEN } from "../config";

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

  return expectedHash === hash;
}

export function extractInitData(c: Context): string {
  return c.req.header("X-Telegram-Init-Data") ?? c.req.query("initData") ?? "";
}

export const authMiddleware = createMiddleware(async (c, next) => {
  const initData = extractInitData(c);
  if (!initData) return c.json({ error: "Unauthorized" }, 401);
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!token || !validateInitData(initData, token)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});
