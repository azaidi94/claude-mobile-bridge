import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createHmac } from "crypto";
import {
  validateInitData,
  authMiddleware,
  timingSafeCompare,
} from "../web/auth";
import { Hono } from "hono";

function makeInitData(
  botToken: string,
  userId: number,
  timestamp?: number,
): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const pairs = [
    `auth_date=${ts}`,
    `user={"id":${userId},"first_name":"Test"}`,
  ].sort();
  const dataCheckString = pairs.join("\n");
  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const hash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");
  return `${pairs.join("&")}&hash=${hash}`;
}

function buildApp() {
  const app = new Hono<{ Bindings: { remoteAddr: string | null } }>();
  app.use("*", authMiddleware);
  app.get("/ok", (c) => c.json({ ok: true }));
  return app;
}

async function makeRequest(
  app: Hono<{ Bindings: { remoteAddr: string | null } }>,
  init: { remoteAddr: string | null; forwardedFor?: string },
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.forwardedFor) headers["x-forwarded-for"] = init.forwardedFor;
  return app.fetch(new Request("http://local/ok", { headers }), {
    remoteAddr: init.remoteAddr,
  });
}

describe("authMiddleware LAN bypass", () => {
  let savedLanBypass: string | undefined;
  let savedAuthBypass: string | undefined;

  beforeEach(() => {
    savedLanBypass = process.env.WEB_AUTH_LAN_BYPASS;
    savedAuthBypass = process.env.WEB_AUTH_BYPASS;
    delete process.env.WEB_AUTH_BYPASS;
  });

  afterEach(() => {
    if (savedLanBypass === undefined) {
      delete process.env.WEB_AUTH_LAN_BYPASS;
    } else {
      process.env.WEB_AUTH_LAN_BYPASS = savedLanBypass;
    }
    if (savedAuthBypass === undefined) {
      delete process.env.WEB_AUTH_BYPASS;
    } else {
      process.env.WEB_AUTH_BYPASS = savedAuthBypass;
    }
  });

  test("bypasses auth for 192.168.x.x LAN address", async () => {
    process.env.WEB_AUTH_LAN_BYPASS = "true";
    const app = buildApp();
    const res = await makeRequest(app, { remoteAddr: "192.168.1.50" });
    expect(res.status).toBe(200);
  });

  test("bypasses auth for 10.x.x.x LAN address", async () => {
    process.env.WEB_AUTH_LAN_BYPASS = "true";
    const app = buildApp();
    const res = await makeRequest(app, { remoteAddr: "10.0.0.5" });
    expect(res.status).toBe(200);
  });

  test("bypasses auth for 172.16.x.x LAN address", async () => {
    process.env.WEB_AUTH_LAN_BYPASS = "true";
    const app = buildApp();
    const res = await makeRequest(app, { remoteAddr: "172.16.0.1" });
    expect(res.status).toBe(200);
  });

  test("bypasses auth for 172.31.x.x LAN address (upper bound)", async () => {
    process.env.WEB_AUTH_LAN_BYPASS = "true";
    const app = buildApp();
    const res = await makeRequest(app, { remoteAddr: "172.31.255.255" });
    expect(res.status).toBe(200);
  });

  test("enforces auth when X-Forwarded-For is present even from LAN", async () => {
    process.env.WEB_AUTH_LAN_BYPASS = "true";
    const app = buildApp();
    const res = await makeRequest(app, {
      remoteAddr: "192.168.1.50",
      forwardedFor: "203.0.113.5",
    });
    expect(res.status).toBe(401);
  });

  test("enforces auth for public IP when LAN bypass is enabled", async () => {
    process.env.WEB_AUTH_LAN_BYPASS = "true";
    const app = buildApp();
    const res = await makeRequest(app, { remoteAddr: "203.0.113.5" });
    expect(res.status).toBe(401);
  });

  test("enforces auth when WEB_AUTH_LAN_BYPASS=false", async () => {
    process.env.WEB_AUTH_LAN_BYPASS = "false";
    const app = buildApp();
    const res = await makeRequest(app, { remoteAddr: "192.168.1.50" });
    expect(res.status).toBe(401);
  });

  test("bypasses auth for IPv6-mapped 192.168.x.x (::ffff:192.168.x.x)", async () => {
    process.env.WEB_AUTH_LAN_BYPASS = "true";
    const app = buildApp();
    const res = await makeRequest(app, { remoteAddr: "::ffff:192.168.0.174" });
    expect(res.status).toBe(200);
  });

  test("bypasses auth for IPv6-mapped 10.x.x.x (::ffff:10.x.x.x)", async () => {
    process.env.WEB_AUTH_LAN_BYPASS = "true";
    const app = buildApp();
    const res = await makeRequest(app, { remoteAddr: "::ffff:10.0.0.5" });
    expect(res.status).toBe(200);
  });

  test("does NOT bypass 172.32.x.x (just outside RFC 1918 range)", async () => {
    process.env.WEB_AUTH_LAN_BYPASS = "true";
    const app = buildApp();
    const res = await makeRequest(app, { remoteAddr: "172.32.0.1" });
    expect(res.status).toBe(401);
  });

  test("bypasses auth for loopback 127.0.0.1 when LAN bypass is enabled", async () => {
    process.env.WEB_AUTH_LAN_BYPASS = "true";
    const app = buildApp();
    const res = await makeRequest(app, { remoteAddr: "127.0.0.1" });
    expect(res.status).toBe(200);
  });

  test("bypasses auth for IPv6 loopback ::1 when LAN bypass is enabled", async () => {
    process.env.WEB_AUTH_LAN_BYPASS = "true";
    const app = buildApp();
    const res = await makeRequest(app, { remoteAddr: "::1" });
    expect(res.status).toBe(200);
  });
});

describe("validateInitData", () => {
  test("accepts valid initData", () => {
    const initData = makeInitData("test-token", 42);
    expect(validateInitData(initData, "test-token")).toBe(true);
  });

  test("rejects wrong token", () => {
    const initData = makeInitData("other-token", 42);
    expect(validateInitData(initData, "test-token")).toBe(false);
  });

  test("rejects stale initData (> 5 minutes old)", () => {
    const staleTs = Math.floor(Date.now() / 1000) - 400;
    const initData = makeInitData("test-token", 42, staleTs);
    expect(validateInitData(initData, "test-token", 300)).toBe(false);
  });

  test("accepts fresh initData within window", () => {
    const ts = Math.floor(Date.now() / 1000) - 60;
    const initData = makeInitData("test-token", 42, ts);
    expect(validateInitData(initData, "test-token", 300)).toBe(true);
  });
});

// Derive ids from the live config: bun auto-loads .env, so the allowlist may
// be the developer's real TELEGRAM_ALLOWED_USERS rather than ensure-test-env's
// fallback ("1"). ALLOWED_USERS is frozen at config import, so read it back.
describe("authMiddleware allowlist", () => {
  let savedToken: string | undefined;
  let savedAuthBypass: string | undefined;
  let savedLanBypass: string | undefined;

  beforeEach(() => {
    savedToken = process.env.TELEGRAM_BOT_TOKEN;
    savedAuthBypass = process.env.WEB_AUTH_BYPASS;
    savedLanBypass = process.env.WEB_AUTH_LAN_BYPASS;
    process.env.TELEGRAM_BOT_TOKEN = "test-placeholder-token";
    delete process.env.WEB_AUTH_BYPASS;
    delete process.env.WEB_AUTH_LAN_BYPASS;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = savedToken;
    if (savedAuthBypass === undefined) delete process.env.WEB_AUTH_BYPASS;
    else process.env.WEB_AUTH_BYPASS = savedAuthBypass;
    if (savedLanBypass === undefined) delete process.env.WEB_AUTH_LAN_BYPASS;
    else process.env.WEB_AUTH_LAN_BYPASS = savedLanBypass;
  });

  function buildInitDataApp() {
    const app = new Hono<{ Bindings: { remoteAddr: string | null } }>();
    app.use("*", authMiddleware);
    app.get("/ok", (c) => c.json({ ok: true }));
    return app;
  }

  async function fetchWithInitData(initData: string): Promise<Response> {
    const app = buildInitDataApp();
    return app.fetch(
      new Request(`http://local/ok?initData=${encodeURIComponent(initData)}`),
      { remoteAddr: "203.0.113.5" },
    );
  }

  test("allows user in ALLOWED_USERS", async () => {
    const { ALLOWED_USERS } = await import("../config");
    const initData = makeInitData("test-placeholder-token", ALLOWED_USERS[0]!);
    const res = await fetchWithInitData(initData);
    expect(res.status).toBe(200);
  });

  test("rejects user NOT in ALLOWED_USERS", async () => {
    const { ALLOWED_USERS } = await import("../config");
    const outsider = Math.max(...ALLOWED_USERS, 0) + 1;
    const initData = makeInitData("test-placeholder-token", outsider);
    const res = await fetchWithInitData(initData);
    expect(res.status).toBe(401);
  });

  test("rejects initData with missing user field", async () => {
    // Build initData without a user param
    const ts = Math.floor(Date.now() / 1000);
    const pairs = [`auth_date=${ts}`].sort();
    const dataCheckString = pairs.join("\n");
    const secretKey = createHmac("sha256", "WebAppData")
      .update("test-placeholder-token")
      .digest();
    const hash = createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");
    const initData = `${pairs.join("&")}&hash=${hash}`;
    const res = await fetchWithInitData(initData);
    expect(res.status).toBe(401);
  });

  test("rejects initData with malformed user JSON", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const pairs = [`auth_date=${ts}`, `user=not-valid-json`].sort();
    const dataCheckString = pairs.join("\n");
    const secretKey = createHmac("sha256", "WebAppData")
      .update("test-placeholder-token")
      .digest();
    const hash = createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");
    const initData = `${pairs.join("&")}&hash=${hash}`;
    const res = await fetchWithInitData(initData);
    expect(res.status).toBe(401);
  });
});

describe("timingSafeCompare", () => {
  test("returns true for equal strings", () => {
    expect(timingSafeCompare("hello", "hello")).toBe(true);
  });

  test("returns false for different strings", () => {
    expect(timingSafeCompare("hello", "world")).toBe(false);
  });

  test("returns false for strings of different lengths", () => {
    expect(timingSafeCompare("short", "much-longer-string")).toBe(false);
  });
});
