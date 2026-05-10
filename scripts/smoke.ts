#!/usr/bin/env bun
/**
 * Tier-1 smoke test for the bot's bridge plumbing.
 *
 * Drives all HTTP-reachable scenarios end-to-end against a running bot,
 * asserts log evidence, and probes Telegram-side runner liveness via
 * getWebhookInfo. Exits 0 on full pass, 1 on any failure.
 *
 * Run: WEB_AUTH_LAN_BYPASS=true bun run smoke
 *
 * The script forges a valid Telegram WebApp initData using the bot token,
 * so it doesn't need the LAN bypass; either path works.
 */

import { createHmac } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

const LOG_PATH = `${process.env.HOME}/Library/Logs/claude-mobile-bridge/bot.log`;
const BOT_LOG_TAIL_BYTES = 200_000;

interface Env {
  botToken: string;
  webPort: number;
  allowedUserId: number;
}

function loadEnv(): Env {
  const text = readFileSync(resolve(".env"), "utf8");
  const get = (k: string): string => {
    const m = text.match(new RegExp(`^${k}=(.*)$`, "m"));
    if (!m) throw new Error(`${k} missing from .env`);
    return m[1]!.trim();
  };
  const usersRaw = get("TELEGRAM_ALLOWED_USERS");
  const firstUser = parseInt(usersRaw.split(",")[0]!.trim(), 10);
  if (!Number.isFinite(firstUser)) {
    throw new Error(
      `first TELEGRAM_ALLOWED_USERS entry not numeric: ${usersRaw}`,
    );
  }
  return {
    botToken: get("TELEGRAM_BOT_TOKEN"),
    webPort: parseInt(process.env.WEB_PORT ?? get("WEB_PORT"), 10) || 4242,
    allowedUserId: firstUser,
  };
}

function makeInitData(botToken: string, userId: number): string {
  const authDate = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({
    id: userId,
    first_name: "smoke",
    username: "smoke_test",
  });
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "smoke_query",
    user,
  });
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const hash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");
  params.set("hash", hash);
  return params.toString();
}

interface ApiSession {
  id: string;
  name: string;
  dir: string;
  source: "telegram" | "desktop" | "cursor";
  live: boolean;
  active: boolean;
}

interface Step {
  name: string;
  passed: boolean;
  detail?: string;
}

const results: Step[] = [];

function record(name: string, passed: boolean, detail?: string) {
  results.push({ name, passed, detail });
  const tag = passed ? "✓" : "✗";
  console.log(`${tag} ${name}${detail ? `  — ${detail}` : ""}`);
}

async function fetchJson<T>(
  url: string,
  initData: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": initData,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function tailLogAsync(bytes = BOT_LOG_TAIL_BYTES): Promise<string> {
  try {
    const file = Bun.file(LOG_PATH);
    const size = file.size;
    const start = Math.max(0, size - bytes);
    return await file.slice(start, size).text();
  } catch {
    return "";
  }
}

async function readSseUntilDone(
  url: string,
  initData: string,
  timeoutMs: number,
): Promise<{ events: string[]; sawDone: boolean }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const events: string[] = [];
  let sawDone = false;
  try {
    const res = await fetch(url, {
      headers: { "X-Telegram-Init-Data": initData },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      return { events, sawDone };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const payload = dataLine.slice(6);
        events.push(payload);
        try {
          const parsed = JSON.parse(payload);
          if (parsed?.type === "done") {
            sawDone = true;
            ctrl.abort();
            break;
          }
        } catch {}
      }
      if (sawDone) break;
    }
  } catch {
    // expected on abort/timeout
  } finally {
    clearTimeout(timer);
  }
  return { events, sawDone };
}

async function main() {
  const env = loadEnv();
  const initData = makeInitData(env.botToken, env.allowedUserId);
  const base = `http://127.0.0.1:${env.webPort}/api`;

  // --- P1: bot process alive
  const ps = Bun.spawnSync(["pgrep", "-f", "src/index.ts"]);
  const psOut = ps.stdout.toString().trim();
  record("P1 bot process alive", psOut.length > 0, psOut || "no pid");

  // --- P2: getWebhookInfo (snapshot 1)
  const wh1Url = `https://api.telegram.org/bot${env.botToken}/getWebhookInfo`;
  let pending1 = -1;
  try {
    const wh = (await (await fetch(wh1Url)).json()) as {
      result: { url: string; pending_update_count: number };
    };
    pending1 = wh.result.pending_update_count;
    const noWebhook = wh.result.url === "";
    record(
      "P2 telegram has no webhook",
      noWebhook,
      noWebhook ? `pending=${pending1}` : `webhook=${wh.result.url}`,
    );
  } catch (e) {
    record("P2 telegram has no webhook", false, String(e));
  }

  // --- P3: web /api/sessions reachable
  let sessions: ApiSession[] = [];
  try {
    sessions = await fetchJson<ApiSession[]>(`${base}/sessions`, initData);
    record(
      "P3 web /api/sessions reachable",
      true,
      `${sessions.length} sessions`,
    );
  } catch (e) {
    record("P3 web /api/sessions reachable", false, String(e));
    finalize();
    return;
  }

  const cc = sessions.find((s) => s.source === "desktop" && s.live);
  const cursor = sessions.find((s) => s.source === "cursor" && s.live);

  record(
    "P4 at least one live Claude Code session",
    Boolean(cc),
    cc ? cc.name : "none",
  );
  record(
    "P5 at least one live Cursor session",
    Boolean(cursor),
    cursor ? cursor.name : "none — open Cursor in a workspace",
  );

  // --- W1: Web UI → Claude Code round-trip with SSE
  if (cc) {
    try {
      // Fire and forget POST; the SSE stream is what we read.
      const postPromise = fetch(`${base}/sessions/${cc.id}/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Init-Data": initData,
        },
        body: JSON.stringify({
          text: `smoke-web-${Date.now()} - reply with the word PONG`,
        }),
      });
      // Race the SSE read alongside the POST so we don't miss the start.
      const ssePromise = readSseUntilDone(
        `${base}/sessions/${cc.id}/stream?initData=${encodeURIComponent(initData)}`,
        initData,
        30_000,
      );
      const [postRes, sse] = await Promise.all([postPromise, ssePromise]);
      const postOk = postRes.ok;
      const responded = sse.events.some((e) => {
        try {
          const p = JSON.parse(e);
          return (
            p.type === "text" || p.type === "tool" || p.type === "thinking"
          );
        } catch {
          return false;
        }
      });
      record(
        "W1 web → Claude Code: POST accepted",
        postOk,
        `status=${postRes.status}`,
      );
      record(
        "W1 web → Claude Code: SSE delivered events",
        responded || sse.sawDone,
        `events=${sse.events.length} done=${sse.sawDone}`,
      );
    } catch (e) {
      record("W1 web → Claude Code", false, String(e));
    }
  } else {
    record("W1 web → Claude Code", false, "skipped — no CC session");
  }

  // --- W2: Web UI → Cursor (only verifies the bot accepted + emitted to bus)
  if (cursor) {
    try {
      const postRes = await fetch(`${base}/sessions/${cursor.id}/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Init-Data": initData,
        },
        body: JSON.stringify({
          text: `smoke-cursor-${Date.now()} - injection probe`,
        }),
      });
      record(
        "W2 web → Cursor: POST accepted",
        postRes.ok,
        `status=${postRes.status}`,
      );
      // Give the bus and CDP injection a moment.
      await Bun.sleep(2000);
      const log = await tailLogAsync();
      const sawCursorActivity =
        log.includes("cursor-bridge: injected") ||
        log.includes("cursor_bus") ||
        log.includes(`cursor-bridge: cross-post wired for "${cursor.name}"`);
      record(
        "W2 web → Cursor: bridge activity in log",
        sawCursorActivity,
        sawCursorActivity ? "ok" : "no cursor-bridge log entries",
      );
    } catch (e) {
      record("W2 web → Cursor", false, String(e));
    }
  } else {
    record("W2 web → Cursor", false, "skipped — no Cursor session");
  }

  // --- L1: telegram runner liveness via pending_update_count
  // Take a second snapshot ~5s later. If pending_update_count grew during
  // the test (no concurrent real traffic expected), runner is dead.
  // Best-effort: definitive runner verification needs a real TG message (Tier 3).
  await Bun.sleep(5000);
  try {
    const wh2 = (await (await fetch(wh1Url)).json()) as {
      result: { pending_update_count: number };
    };
    const pending2 = wh2.result.pending_update_count;
    const stableOrConsumed = pending2 <= pending1 + 1; // tolerate small drift
    record(
      "L1 telegram pending_update_count not growing",
      stableOrConsumed,
      `before=${pending1} after=${pending2} (best-effort)`,
    );
  } catch (e) {
    record("L1 telegram pending_update_count check", false, String(e));
  }

  finalize();
}

function finalize() {
  console.log();
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`${passed}/${total} passed`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(2);
});
