# Terminal Mini App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Telegram Mini App with a terminal-style UI (Chat, Sessions, Status, Agents) that runs alongside the existing Grammy bot in the same Bun process.

**Architecture:** A Hono HTTP server starts in the same Bun process as the Grammy bot, sharing session state via a `SessionEventBus` (in-memory EventEmitter). The frontend is a React + Vite + Tailwind SPA in `web/`, built to `web/dist/` and served as static files by Hono. Auth on all API routes uses Telegram initData HMAC-SHA256 validation.

**Tech Stack:** Bun, TypeScript, Hono (HTTP + SSE), React 18, Vite, Tailwind CSS v3, `@telegram-apps/sdk`

---

## File Map

**New backend files:**

- `src/web/server.ts` — Hono app factory, mounts middleware + all routes, serves static files
- `src/web/auth.ts` — Telegram initData HMAC-SHA256 validation middleware
- `src/web/sse.ts` — `SessionEventBus`: per-session EventEmitter + SSE stream helper
- `src/web/routes/sessions.ts` — `GET /api/sessions` (live + offline), `GET /api/sessions/:id/stream`, `POST /api/sessions/:id/message`, `POST /api/sessions/:id/activate`
- `src/web/routes/agents.ts` — `POST /api/agents/spawn`
- `src/web/routes/system.ts` — `GET /api/system`

**Modified backend files:**

- `src/index.ts` — call `startWebServer()` after bot init
- `src/config.ts` — already has `WEB_PORT` and `WEB_TOKEN`; add `WEB_ENABLED` export

**New test files:**

- `src/__tests__/web-auth.test.ts`
- `src/__tests__/web-sse.test.ts`
- `src/__tests__/web-sessions-route.test.ts`
- `src/__tests__/web-system-route.test.ts`

**New frontend files (separate `web/` package):**

- `web/package.json`
- `web/vite.config.ts`
- `web/tailwind.config.ts`
- `web/postcss.config.ts`
- `web/index.html`
- `web/src/main.tsx`
- `web/src/App.tsx`
- `web/src/api.ts`
- `web/src/pages/ChatPage.tsx`
- `web/src/pages/SessionsPage.tsx`
- `web/src/pages/StatusPage.tsx`
- `web/src/pages/AgentsPage.tsx`
- `web/src/components/BottomNav.tsx`
- `web/src/components/Terminal.tsx`

---

## Task 1: SessionEventBus

**Files:**

- Create: `src/web/sse.ts`
- Create: `src/__tests__/web-sse.test.ts`

The `SessionEventBus` is an in-memory EventEmitter keyed by session ID. Both the bot's status callbacks and the Mini App's SSE routes emit and subscribe through this bus.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/web-sse.test.ts
import { describe, test, expect } from "bun:test";

async function loadSse() {
  process.env.TELEGRAM_BOT_TOKEN ||= "test";
  process.env.TELEGRAM_ALLOWED_USERS ||= "1";
  return import("../web/sse");
}

describe("SessionEventBus", () => {
  test("emit delivers event to subscriber", async () => {
    const { SessionEventBus } = await loadSse();
    const bus = new SessionEventBus();
    const received: Array<{ type: string; content: string }> = [];

    const unsub = bus.subscribe("session-1", (evt) => received.push(evt));
    bus.emit("session-1", { type: "text", content: "hello" });
    unsub();
    bus.emit("session-1", { type: "text", content: "ignored" });

    expect(received).toEqual([{ type: "text", content: "hello" }]);
  });

  test("subscriber only receives events for its session", async () => {
    const { SessionEventBus } = await loadSse();
    const bus = new SessionEventBus();
    const received: string[] = [];

    bus.subscribe("session-a", (evt) => received.push(`a:${evt.content}`));
    bus.emit("session-a", { type: "text", content: "for-a" });
    bus.emit("session-b", { type: "text", content: "for-b" });

    expect(received).toEqual(["a:for-a"]);
  });

  test("makeStatusCallback emits events to bus", async () => {
    const { SessionEventBus } = await loadSse();
    const bus = new SessionEventBus();
    const received: Array<{ type: string; content: string }> = [];

    bus.subscribe("s1", (evt) => received.push(evt));
    const cb = bus.makeStatusCallback("s1");
    await cb("text", "some output");
    await cb("tool", "Read file");

    expect(received).toEqual([
      { type: "text", content: "some output" },
      { type: "tool", content: "Read file" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test src/__tests__/web-sse.test.ts
```

Expected: `Cannot find module '../web/sse'`

- [ ] **Step 3: Implement `src/web/sse.ts`**

```typescript
import { EventEmitter } from "events";

export interface SseEvent {
  type: "text" | "tool" | "thinking" | "segment_end" | "done" | "send_file";
  content: string;
  segmentId?: number;
}

type SseHandler = (event: SseEvent) => void;

export class SessionEventBus {
  private emitter = new EventEmitter();

  subscribe(sessionId: string, handler: SseHandler): () => void {
    this.emitter.on(sessionId, handler);
    return () => this.emitter.off(sessionId, handler);
  }

  emit(sessionId: string, event: SseEvent): void {
    this.emitter.emit(sessionId, event);
  }

  makeStatusCallback(
    sessionId: string,
  ): (type: string, content: string, segmentId?: number) => Promise<void> {
    return async (type, content, segmentId) => {
      this.emit(sessionId, {
        type: type as SseEvent["type"],
        content,
        segmentId,
      });
    };
  }
}

export const globalEventBus = new SessionEventBus();
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
bun test src/__tests__/web-sse.test.ts
```

Expected: `3 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/web/sse.ts src/__tests__/web-sse.test.ts
git commit -m "feat: add SessionEventBus for SSE streaming"
```

---

## Task 2: Auth Middleware

**Files:**

- Create: `src/web/auth.ts`
- Create: `src/__tests__/web-auth.test.ts`

Validates the `X-Telegram-Init-Data` header using HMAC-SHA256 against `BOT_TOKEN`. Rejects with 401 if missing, invalid, or older than 5 minutes.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/web-auth.test.ts
import { describe, test, expect } from "bun:test";
import { createHmac } from "crypto";

async function loadAuth() {
  process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
  process.env.TELEGRAM_ALLOWED_USERS ||= "1";
  return import("../web/auth");
}

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

describe("validateInitData", () => {
  test("accepts valid initData", async () => {
    const { validateInitData } = await loadAuth();
    const initData = makeInitData("test-token", 42);
    expect(validateInitData(initData, "test-token")).toBe(true);
  });

  test("rejects wrong token", async () => {
    const { validateInitData } = await loadAuth();
    const initData = makeInitData("other-token", 42);
    expect(validateInitData(initData, "test-token")).toBe(false);
  });

  test("rejects stale initData (> 5 minutes old)", async () => {
    const { validateInitData } = await loadAuth();
    const staleTs = Math.floor(Date.now() / 1000) - 400;
    const initData = makeInitData("test-token", 42, staleTs);
    expect(validateInitData(initData, "test-token", 300)).toBe(false);
  });

  test("accepts fresh initData within window", async () => {
    const { validateInitData } = await loadAuth();
    const ts = Math.floor(Date.now() / 1000) - 60;
    const initData = makeInitData("test-token", 42, ts);
    expect(validateInitData(initData, "test-token", 300)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test src/__tests__/web-auth.test.ts
```

Expected: `Cannot find module '../web/auth'`

- [ ] **Step 3: Implement `src/web/auth.ts`**

```typescript
import { createHmac } from "crypto";
import type { Context, Next } from "hono";
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

export async function authMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  const initData = c.req.header("X-Telegram-Init-Data");
  if (!initData || !validateInitData(initData, TELEGRAM_TOKEN)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
}
```

- [ ] **Step 4: Install hono**

```bash
cd /path/to/project && bun add hono
```

- [ ] **Step 5: Run test to confirm it passes**

```bash
bun test src/__tests__/web-auth.test.ts
```

Expected: `4 pass, 0 fail`

- [ ] **Step 6: Commit**

```bash
git add src/web/auth.ts src/__tests__/web-auth.test.ts
git commit -m "feat: add initData HMAC auth middleware"
```

---

## Task 3: System Route

**Files:**

- Create: `src/web/routes/system.ts`
- Create: `src/__tests__/web-system-route.test.ts`

Returns CPU usage (via `loadavg`), memory (via `os.totalmem`/`os.freemem`), disk usage (via `df -k`), and a list of relevant running processes (via `ps`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/web-system-route.test.ts
import { describe, test, expect } from "bun:test";

async function loadSystem() {
  process.env.TELEGRAM_BOT_TOKEN ||= "test";
  process.env.TELEGRAM_ALLOWED_USERS ||= "1";
  return import("../web/routes/system");
}

describe("getSystemStats", () => {
  test("returns cpu, memory, disk, processes fields", async () => {
    const { getSystemStats } = await loadSystem();
    const stats = await getSystemStats();

    expect(typeof stats.cpu).toBe("number");
    expect(stats.cpu).toBeGreaterThanOrEqual(0);
    expect(stats.cpu).toBeLessThanOrEqual(100);

    expect(typeof stats.memory.used).toBe("number");
    expect(typeof stats.memory.total).toBe("number");
    expect(stats.memory.used).toBeLessThanOrEqual(stats.memory.total);

    expect(typeof stats.disk.used).toBe("number");
    expect(typeof stats.disk.total).toBe("number");

    expect(Array.isArray(stats.processes)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test src/__tests__/web-system-route.test.ts
```

Expected: `Cannot find module '../web/routes/system'`

- [ ] **Step 3: Implement `src/web/routes/system.ts`**

```typescript
import { totalmem, freemem, loadavg } from "os";
import { Hono } from "hono";
import { exec } from "child_process";
import { promisify } from "util";
import { authMiddleware } from "../auth";

const execAsync = promisify(exec);

export interface SystemStats {
  cpu: number;
  memory: { used: number; total: number; usedPercent: number };
  disk: { used: number; total: number; usedPercent: number };
  processes: Array<{ name: string; pid: number; cpu: number }>;
}

export async function getSystemStats(): Promise<SystemStats> {
  const total = totalmem();
  const free = freemem();
  const used = total - free;
  const [load1] = loadavg();
  const cpu = Math.min(100, Math.round((load1 / 1) * 100));

  let disk = { used: 0, total: 0, usedPercent: 0 };
  try {
    const { stdout } = await execAsync("df -k /");
    const lines = stdout.trim().split("\n");
    const parts = lines[1]?.split(/\s+/) ?? [];
    const diskTotal = parseInt(parts[1] ?? "0", 10) * 1024;
    const diskUsed = parseInt(parts[2] ?? "0", 10) * 1024;
    disk = {
      used: diskUsed,
      total: diskTotal,
      usedPercent: diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0,
    };
  } catch {}

  let processes: SystemStats["processes"] = [];
  try {
    const { stdout } = await execAsync(
      "ps -eo pid,pcpu,comm | grep -E '(claude|bun|channel-relay|node)' | grep -v grep | head -20",
    );
    processes = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return {
          pid: parseInt(parts[0] ?? "0", 10),
          cpu: parseFloat(parts[1] ?? "0"),
          name: parts.slice(2).join(" ").split("/").pop() ?? "",
        };
      });
  } catch {}

  return {
    cpu,
    memory: {
      used,
      total,
      usedPercent: Math.round((used / total) * 100),
    },
    disk,
    processes,
  };
}

export function createSystemRouter(): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.get("/", async (c) => c.json(await getSystemStats()));
  return app;
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
bun test src/__tests__/web-system-route.test.ts
```

Expected: `1 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/system.ts src/__tests__/web-system-route.test.ts
git commit -m "feat: add /api/system route with CPU/mem/disk stats"
```

---

## Task 4: Sessions Route

**Files:**

- Create: `src/web/routes/sessions.ts`
- Create: `src/__tests__/web-sessions-route.test.ts`

Handles listing sessions, sending messages, and streaming SSE output.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/web-sessions-route.test.ts
import { describe, test, expect } from "bun:test";

async function loadSessions() {
  process.env.TELEGRAM_BOT_TOKEN ||= "test";
  process.env.TELEGRAM_ALLOWED_USERS ||= "1";
  return import("../web/routes/sessions");
}

describe("serializeSessions", () => {
  test("maps SessionInfo to API shape", async () => {
    const { serializeSessions } = await loadSessions();
    const sessions = new Map([
      [
        "my-project",
        {
          id: "abc123",
          name: "my-project",
          dir: "/home/user/my-project",
          lastActivity: 1700000000000,
          source: "desktop" as const,
          pid: 1234,
        },
      ],
    ]);
    const result = serializeSessions(sessions);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "abc123",
      name: "my-project",
      dir: "/home/user/my-project",
      source: "desktop",
      live: true,
    });
  });

  test("sorts by lastActivity descending", async () => {
    const { serializeSessions } = await loadSessions();
    const sessions = new Map([
      [
        "old",
        {
          id: "1",
          name: "old",
          dir: "/old",
          lastActivity: 1000,
          source: "desktop" as const,
        },
      ],
      [
        "new",
        {
          id: "2",
          name: "new",
          dir: "/new",
          lastActivity: 9000,
          source: "desktop" as const,
        },
      ],
    ]);
    const result = serializeSessions(sessions);
    expect(result[0]!.name).toBe("new");
    expect(result[1]!.name).toBe("old");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test src/__tests__/web-sessions-route.test.ts
```

Expected: `Cannot find module '../web/routes/sessions'`

- [ ] **Step 3: Implement `src/web/routes/sessions.ts`**

```typescript
import { Hono } from "hono";
import { stream } from "hono/streaming";
import {
  getSessions,
  getActiveSession,
  setActiveSession,
} from "../../sessions";
import { listOfflineSessions } from "../../sessions/offline";
import { globalEventBus } from "../sse";
import { authMiddleware } from "../auth";
import type { SessionInfo } from "../../sessions/types";
import { session as claudeSession } from "../../session";

export interface ApiSession {
  id: string;
  name: string;
  dir: string;
  lastActivity: number;
  source: "telegram" | "desktop";
  live: boolean;
  active: boolean;
}

export function serializeSessions(
  sessions: Map<string, SessionInfo>,
): ApiSession[] {
  const active = getActiveSession();
  return [...sessions.values()]
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map((s) => ({
      id: s.id,
      name: s.name,
      dir: s.dir,
      lastActivity: s.lastActivity,
      source: s.source,
      live: true,
      active: active?.name === s.name,
    }));
}

export function createSessionsRouter(): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // GET /api/sessions — live sessions + recent offline sessions
  app.get("/", async (c) => {
    const live = serializeSessions(getSessions());
    const liveDirs = new Set(live.map((s) => s.dir));
    const offline = await listOfflineSessions();
    const offlineApi: ApiSession[] = offline
      .filter((o) => !liveDirs.has(o.dir))
      .map((o) => ({
        id: o.encodedDir,
        name: o.dir.split("/").pop() ?? o.encodedDir,
        dir: o.dir,
        lastActivity: o.lastActivity,
        source: "desktop" as const,
        live: false,
        active: false,
      }));
    return c.json([...live, ...offlineApi]);
  });

  // GET /api/sessions/:id/stream — SSE stream of events for session
  app.get("/:id/stream", (c) => {
    const sessionId = c.req.param("id");
    return stream(
      c,
      async (s) => {
        const unsub = globalEventBus.subscribe(sessionId, async (evt) => {
          await s.write(`data: ${JSON.stringify(evt)}\n\n`);
        });
        const ping = setInterval(async () => {
          await s.write(": ping\n\n");
        }, 15000);
        await new Promise<void>((resolve) => {
          s.onAbort(() => {
            unsub();
            clearInterval(ping);
            resolve();
          });
        });
      },
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      },
    );
  });

  // POST /api/sessions/:id/message — send message to active session via Agent SDK
  app.post("/:id/message", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json<{ text: string }>();
    if (!body.text?.trim()) return c.json({ error: "text required" }, 400);

    const cb = globalEventBus.makeStatusCallback(sessionId);
    // ctx is undefined here — ask-user and plan-mode prompts won't show inline keyboards,
    // which is acceptable for the web interface.
    claudeSession.sendMessageStreaming(body.text, "web", 0, cb).catch(() => {});
    return c.json({ ok: true });
  });

  // POST /api/sessions/:id/activate — switch active session by name
  app.post("/:name/activate", (c) => {
    const name = c.req.param("name");
    const sessions = getSessions();
    const found = sessions.get(name);
    if (!found) return c.json({ error: "session not found" }, 404);
    setActiveSession(name);
    claudeSession.loadFromRegistry(found);
    return c.json({ ok: true });
  });

  return app;
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
bun test src/__tests__/web-sessions-route.test.ts
```

Expected: `2 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/sessions.ts src/__tests__/web-sessions-route.test.ts
git commit -m "feat: add /api/sessions routes with SSE stream"
```

---

## Task 5: Agents Route

**Files:**

- Create: `src/web/routes/agents.ts`

Spawns a new Claude Code session in a given directory. Reuses the existing `addTelegramSession` logic from `sessions/watcher.ts`.

- [ ] **Step 1: Implement `src/web/routes/agents.ts`**

```typescript
import { Hono } from "hono";
import { authMiddleware } from "../auth";
import { addTelegramSession } from "../../sessions";
import { existsSync } from "fs";

export function createAgentsRouter(): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/spawn", async (c) => {
    const body = await c.req.json<{ dir: string }>();
    if (!body.dir?.trim()) return c.json({ error: "dir required" }, 400);
    if (!existsSync(body.dir)) return c.json({ error: "dir not found" }, 404);

    const sess = await addTelegramSession(body.dir);
    return c.json({ ok: true, sessionId: sess.id, name: sess.name });
  });

  return app;
}
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors in `src/web/routes/agents.ts`

- [ ] **Step 3: Commit**

```bash
git add src/web/routes/agents.ts
git commit -m "feat: add /api/agents/spawn route"
```

---

## Task 6: Hono Server + Wire into index.ts

**Files:**

- Create: `src/web/server.ts`
- Modify: `src/index.ts`

Assembles all routes into one Hono app, serves `web/dist/` static files, and exports `startWebServer()`.

- [ ] **Step 1: Implement `src/web/server.ts`**

```typescript
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createSessionsRouter } from "./routes/sessions";
import { createAgentsRouter } from "./routes/agents";
import { createSystemRouter } from "./routes/system";
import { WEB_PORT } from "../config";
import { info, warn } from "../logger";
import { resolve, dirname } from "path";

const WEB_DIST = resolve(dirname(import.meta.dir), "..", "web", "dist");

export function startWebServer(): void {
  const port = WEB_PORT ?? 3000;

  const app = new Hono();

  app.route("/api/sessions", createSessionsRouter());
  app.route("/api/agents", createAgentsRouter());
  app.route("/api/system", createSystemRouter());

  app.use("/*", serveStatic({ root: WEB_DIST }));

  app.get("*", async (c) => {
    return c.html(
      await Bun.file(`${WEB_DIST}/index.html`)
        .text()
        .catch(() => "Mini App not built. Run: cd web && bun run build"),
    );
  });

  Bun.serve({ port, fetch: app.fetch });
  info(`web: server listening on port ${port}`);
}
```

- [ ] **Step 2: Add `WEB_ENABLED` export to `src/config.ts`**

Open `src/config.ts`. After the existing `WEB_PORT` and `WEB_TOKEN` lines (around line 287), add:

```typescript
export const WEB_ENABLED =
  (process.env.WEB_ENABLED || "false").toLowerCase() === "true";
```

- [ ] **Step 3: Wire into `src/index.ts`**

Add import at top of `src/index.ts` (after existing imports):

```typescript
import { startWebServer } from "./web/server";
import { WEB_ENABLED } from "./config";
```

Add call after `info(`bot: @${botInfo.username} ready`);` (around line 77):

```typescript
if (WEB_ENABLED) {
  startWebServer();
}
```

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 5: Add `WEB_ENABLED=true` and `WEB_PORT=3000` to `.env.example`**

Open `.env.example` and append:

```
# Mini App web server
WEB_ENABLED=false
WEB_PORT=3000
```

- [ ] **Step 6: Commit**

```bash
git add src/web/server.ts src/index.ts src/config.ts .env.example
git commit -m "feat: add Hono web server wired into bot process"
```

---

## Task 7: Frontend Scaffold

**Files:**

- Create: `web/package.json`
- Create: `web/vite.config.ts`
- Create: `web/tailwind.config.ts`
- Create: `web/postcss.config.ts`
- Create: `web/index.html`
- Create: `web/src/main.tsx`

Sets up the React + Vite + Tailwind project.

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "claude-bridge-miniapp",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "@telegram-apps/sdk": "^2.9.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.16",
    "typescript": "^5.7.2",
    "vite": "^6.0.3"
  }
}
```

- [ ] **Step 2: Create `web/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
```

- [ ] **Step 3: Create `web/tailwind.config.ts`**

```typescript
import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: "#0a0a0a",
          surface: "#111111",
          border: "#222222",
          green: "#00ff88",
          muted: "#666666",
          text: "#cccccc",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 4: Create `web/postcss.config.ts`**

```typescript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 5: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"
    />
    <title>Claude Bridge</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `web/src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 7: Create `web/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

* {
  box-sizing: border-box;
}

body {
  background-color: #0a0a0a;
  color: #cccccc;
  margin: 0;
  padding: 0;
  overflow: hidden;
  height: 100vh;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

#root {
  height: 100vh;
  display: flex;
  flex-direction: column;
}
```

- [ ] **Step 8: Install frontend dependencies**

```bash
cd web && bun install
```

- [ ] **Step 9: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"]
}
```

- [ ] **Step 10: Commit**

```bash
git add web/
git commit -m "feat: scaffold React + Vite + Tailwind frontend"
```

---

## Task 8: API Client + App Shell

**Files:**

- Create: `web/src/api.ts`
- Create: `web/src/App.tsx`
- Create: `web/src/components/BottomNav.tsx`

The API client reads `X-Telegram-Init-Data` from `window.Telegram.WebApp.initData` and attaches it to every request.

- [ ] **Step 1: Create `web/src/api.ts`**

```typescript
const BASE = "/api";

function getInitData(): string {
  return window.Telegram?.WebApp?.initData ?? "";
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Telegram-Init-Data": getInitData(),
  };
}

export interface ApiSession {
  id: string;
  name: string;
  dir: string;
  lastActivity: number;
  source: "telegram" | "desktop";
  live: boolean;
  active: boolean;
}

export interface SystemStats {
  cpu: number;
  memory: { used: number; total: number; usedPercent: number };
  disk: { used: number; total: number; usedPercent: number };
  processes: Array<{ name: string; pid: number; cpu: number }>;
}

export interface SseEvent {
  type: "text" | "tool" | "thinking" | "segment_end" | "done" | "send_file";
  content: string;
  segmentId?: number;
}

export const api = {
  async getSessions(): Promise<ApiSession[]> {
    const res = await fetch(`${BASE}/sessions`, { headers: headers() });
    return res.json();
  },

  async sendMessage(sessionId: string, text: string): Promise<void> {
    await fetch(`${BASE}/sessions/${sessionId}/message`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ text }),
    });
  },

  streamSession(
    sessionId: string,
    onEvent: (evt: SseEvent) => void,
    onError?: () => void,
  ): () => void {
    const url = `${BASE}/sessions/${sessionId}/stream`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch {}
    };
    if (onError) es.onerror = onError;
    return () => es.close();
  },

  async getSystem(): Promise<SystemStats> {
    const res = await fetch(`${BASE}/system`, { headers: headers() });
    return res.json();
  },

  async spawnAgent(dir: string): Promise<{ sessionId: string; name: string }> {
    const res = await fetch(`${BASE}/agents/spawn`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ dir }),
    });
    return res.json();
  },
};
```

- [ ] **Step 2: Create `web/src/components/BottomNav.tsx`**

```tsx
type Tab = "chat" | "sessions" | "status" | "agents";

interface BottomNavProps {
  active: Tab;
  onChange: (tab: Tab) => void;
}

const TABS: Array<{ id: Tab; icon: string; label: string }> = [
  { id: "chat", icon: "⌨", label: "Chat" },
  { id: "sessions", icon: "▤", label: "Sessions" },
  { id: "status", icon: "◉", label: "Status" },
  { id: "agents", icon: "◈", label: "Agents" },
];

export function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <nav className="flex bg-terminal-surface border-t border-terminal-border pb-safe">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-xs uppercase tracking-widest transition-colors ${
            active === tab.id ? "text-terminal-green" : "text-terminal-muted"
          }`}
        >
          <span className="text-base">{tab.icon}</span>
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 3: Create `web/src/App.tsx`**

```tsx
import { useState } from "react";
import { BottomNav } from "./components/BottomNav";
import { ChatPage } from "./pages/ChatPage";
import { SessionsPage } from "./pages/SessionsPage";
import { StatusPage } from "./pages/StatusPage";
import { AgentsPage } from "./pages/AgentsPage";

type Tab = "chat" | "sessions" | "status" | "agents";

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <div className="flex flex-col h-screen bg-terminal-bg text-terminal-text font-mono overflow-hidden">
      <div className="flex-1 overflow-hidden">
        {tab === "chat" && <ChatPage />}
        {tab === "sessions" && (
          <SessionsPage onSwitchToChat={() => setTab("chat")} />
        )}
        {tab === "status" && <StatusPage />}
        {tab === "agents" && <AgentsPage />}
      </div>
      <BottomNav active={tab} onChange={setTab} />
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
cd .. && git add web/src/api.ts web/src/App.tsx web/src/components/BottomNav.tsx
git commit -m "feat: add API client and app shell with bottom nav"
```

---

## Task 9: ChatPage

**Files:**

- Create: `web/src/components/Terminal.tsx`
- Create: `web/src/pages/ChatPage.tsx`

Displays streaming SSE events in a terminal-style scrolling view. Input bar sends messages to the active session.

- [ ] **Step 1: Create `web/src/components/Terminal.tsx`**

```tsx
import { useEffect, useRef } from "react";
import type { SseEvent } from "../api";

interface TerminalProps {
  events: SseEvent[];
  streaming: boolean;
}

function eventClass(type: SseEvent["type"]): string {
  switch (type) {
    case "text":
      return "text-terminal-text";
    case "tool":
      return "text-terminal-muted text-xs";
    case "thinking":
      return "text-terminal-muted italic text-xs";
    default:
      return "text-terminal-muted";
  }
}

function eventPrefix(type: SseEvent["type"]): string {
  switch (type) {
    case "tool":
      return "⚙ ";
    case "thinking":
      return "… ";
    default:
      return "";
  }
}

export function Terminal({ events, streaming }: TerminalProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-1 text-sm leading-relaxed">
      {events.map((evt, i) =>
        evt.type !== "segment_end" && evt.type !== "done" ? (
          <div key={i} className={eventClass(evt.type)}>
            <span className="text-terminal-muted">{eventPrefix(evt.type)}</span>
            {evt.content}
          </div>
        ) : null,
      )}
      {streaming && (
        <span className="inline-block w-2 h-4 bg-terminal-green animate-pulse" />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
```

- [ ] **Step 2: Create `web/src/pages/ChatPage.tsx`**

```tsx
import { useState, useEffect, useRef, useCallback } from "react";
import { api, type ApiSession, type SseEvent } from "../api";
import { Terminal } from "../components/Terminal";

export function ChatPage() {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    api.getSessions().then((s) => {
      setSessions(s);
      const active = s.find((x) => x.active) ?? s[0];
      if (active) setActiveId(active.id);
    });
  }, []);

  useEffect(() => {
    if (!activeId) return;
    unsubRef.current?.();
    setEvents([]);
    setStreaming(false);
    const unsub = api.streamSession(activeId, (evt) => {
      if (evt.type === "done") {
        setStreaming(false);
      } else {
        setStreaming(true);
        setEvents((prev) => [...prev, evt]);
      }
    });
    unsubRef.current = unsub;
    return unsub;
  }, [activeId]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeId) return;
    setInput("");
    setEvents((prev) => [
      ...prev,
      { type: "text", content: `› ${text}` } as SseEvent,
    ]);
    setStreaming(true);
    await api.sendMessage(activeId, text);
  }, [input, activeId]);

  const activeSession = sessions.find((s) => s.id === activeId);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border bg-terminal-surface">
        <span className="text-terminal-green text-sm font-bold">
          {activeSession?.name ?? "claude-bridge"}
        </span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-terminal-bg border border-terminal-border text-terminal-green">
          {streaming ? "● live" : "○ idle"}
        </span>
      </div>
      <Terminal events={events} streaming={streaming} />
      <div className="flex gap-2 p-2 border-t border-terminal-border bg-terminal-surface">
        <input
          className="flex-1 bg-terminal-bg border border-terminal-border rounded-lg px-3 py-2 text-sm text-terminal-text placeholder-terminal-muted focus:outline-none focus:border-terminal-green"
          placeholder="Message..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button
          onClick={send}
          className="bg-terminal-green text-black font-bold rounded-lg px-4 py-2 text-sm"
        >
          ↑
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/Terminal.tsx web/src/pages/ChatPage.tsx
git commit -m "feat: add ChatPage with SSE terminal streaming"
```

---

## Task 10: SessionsPage

**Files:**

- Create: `web/src/pages/SessionsPage.tsx`

Lists live sessions (green dot, switch button) and offline sessions (resume launches a new in-process session).

- [ ] **Step 1: Create `web/src/pages/SessionsPage.tsx`**

```tsx
import { useEffect, useState } from "react";
import { api, type ApiSession } from "../api";

interface SessionsPageProps {
  onSwitchToChat: () => void;
}

function timeSince(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function SessionsPage({ onSwitchToChat }: SessionsPageProps) {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    api.getSessions().then((s) => {
      setSessions(s);
      setLoading(false);
    });
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleActivate = async (session: ApiSession) => {
    if (session.live) {
      await fetch(`/api/sessions/${session.name}/activate`, {
        method: "POST",
        headers: {
          "X-Telegram-Init-Data": window.Telegram?.WebApp?.initData ?? "",
        },
      });
    } else {
      // Offline session — spawn in-process and switch
      await api.spawnAgent(session.dir);
    }
    onSwitchToChat();
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border bg-terminal-surface">
        <span className="text-terminal-green text-sm font-bold">sessions</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-terminal-bg border border-terminal-border text-terminal-green">
          {sessions.filter((s) => s.live).length} live
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {loading && (
          <p className="text-terminal-muted text-xs p-2">Loading...</p>
        )}
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
              session.active
                ? "border-terminal-green bg-terminal-surface"
                : "border-terminal-border bg-terminal-surface"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${
                session.live
                  ? "bg-terminal-green shadow-[0_0_6px_#00ff88]"
                  : "bg-terminal-muted"
              }`}
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-terminal-text truncate">
                {session.name}
              </div>
              <div className="text-xs text-terminal-muted truncate">
                {session.dir} · {timeSince(session.lastActivity)}
              </div>
            </div>
            <button
              onClick={() => handleActivate(session)}
              className={`text-xs px-2 py-1 rounded border flex-shrink-0 ${
                session.active
                  ? "border-terminal-green text-terminal-green"
                  : "border-terminal-border text-terminal-muted"
              }`}
            >
              {session.active ? "active" : session.live ? "switch" : "resume"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/SessionsPage.tsx
git commit -m "feat: add SessionsPage with live/offline session list"
```

---

## Task 11: StatusPage

**Files:**

- Create: `web/src/pages/StatusPage.tsx`

Polls `/api/system` every 5 seconds and renders CPU/mem/disk gauges + process list.

- [ ] **Step 1: Create `web/src/pages/StatusPage.tsx`**

```tsx
import { useEffect, useState } from "react";
import { api, type SystemStats } from "../api";

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / 1024 ** 2).toFixed(0)}MB`;
}

interface GaugeProps {
  label: string;
  value: number;
  display: string;
  warn?: boolean;
}

function Gauge({ label, value, display, warn }: GaugeProps) {
  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg p-3 text-center">
      <div className="text-terminal-muted text-xs uppercase tracking-widest mb-1">
        {label}
      </div>
      <div
        className={`font-mono text-xl font-bold ${warn ? "text-yellow-400" : "text-terminal-green"}`}
      >
        {display}
      </div>
      <div className="mt-2 h-1 rounded bg-terminal-bg overflow-hidden">
        <div
          className={`h-1 rounded transition-all ${warn ? "bg-yellow-400" : "bg-terminal-green"}`}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
    </div>
  );
}

export function StatusPage() {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    const fetch = () =>
      api
        .getSystem()
        .then(setStats)
        .catch(() => {});
    fetch();
    const id = setInterval(fetch, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-terminal-border bg-terminal-surface">
        <span className="text-terminal-green text-sm font-bold">system</span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {!stats && <p className="text-terminal-muted text-xs">Loading...</p>}
        {stats && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Gauge
                label="CPU"
                value={stats.cpu}
                display={`${stats.cpu}%`}
                warn={stats.cpu > 80}
              />
              <Gauge
                label="Memory"
                value={stats.memory.usedPercent}
                display={`${stats.memory.usedPercent}%`}
                warn={stats.memory.usedPercent > 80}
              />
              <Gauge
                label="Disk"
                value={stats.disk.usedPercent}
                display={`${stats.disk.usedPercent}%`}
                warn={stats.disk.usedPercent > 85}
              />
              <Gauge
                label="Memory Used"
                value={stats.memory.usedPercent}
                display={formatBytes(stats.memory.used)}
              />
            </div>
            <div>
              <div className="text-xs text-terminal-muted uppercase tracking-widest mb-2">
                Processes
              </div>
              <div className="space-y-1">
                {stats.processes.map((p, i) => (
                  <div
                    key={i}
                    className="flex justify-between text-xs font-mono py-1 border-b border-terminal-border last:border-0"
                  >
                    <span className="text-terminal-text">{p.name}</span>
                    <span className="text-terminal-muted">PID {p.pid}</span>
                    <span className="text-terminal-green">
                      {p.cpu.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/StatusPage.tsx
git commit -m "feat: add StatusPage with system gauges and process list"
```

---

## Task 12: AgentsPage

**Files:**

- Create: `web/src/pages/AgentsPage.tsx`

Lists live sessions as agents (follow/interrupt actions) and provides a spawn form.

- [ ] **Step 1: Create `web/src/pages/AgentsPage.tsx`**

```tsx
import { useEffect, useState } from "react";
import { api, type ApiSession } from "../api";

export function AgentsPage() {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [spawnDir, setSpawnDir] = useState("");
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    api.getSessions().then((s) => setSessions(s.filter((x) => x.live)));

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  const spawn = async () => {
    if (!spawnDir.trim()) return;
    setSpawning(true);
    setError(null);
    try {
      await api.spawnAgent(spawnDir.trim());
      setSpawnDir("");
      await refresh();
    } catch {
      setError("Failed to spawn agent");
    } finally {
      setSpawning(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border bg-terminal-surface">
        <span className="text-terminal-green text-sm font-bold">agents</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-terminal-bg border border-terminal-border text-terminal-green">
          {sessions.length} running
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        <div className="flex gap-2 mb-3">
          <input
            className="flex-1 bg-terminal-bg border border-terminal-border rounded-lg px-3 py-2 text-xs text-terminal-text placeholder-terminal-muted focus:outline-none focus:border-terminal-green"
            placeholder="/path/to/project"
            value={spawnDir}
            onChange={(e) => setSpawnDir(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && spawn()}
          />
          <button
            onClick={spawn}
            disabled={spawning}
            className="text-xs px-3 py-2 rounded-lg border border-terminal-green text-terminal-green bg-terminal-bg disabled:opacity-50"
          >
            {spawning ? "…" : "+ Spawn"}
          </button>
        </div>
        {error && <p className="text-red-400 text-xs">{error}</p>}
        {sessions.map((session) => (
          <div
            key={session.id}
            className="border border-terminal-green/30 bg-terminal-surface rounded-lg p-3"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-terminal-text font-mono">
                {session.name}
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-terminal-bg/50 text-terminal-green border border-terminal-green/40">
                running
              </span>
            </div>
            <div className="text-xs text-terminal-muted truncate mb-2">
              {session.dir}
            </div>
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="text-terminal-muted text-xs text-center py-8">
            No agents running
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/AgentsPage.tsx
git commit -m "feat: add AgentsPage with spawn form and live agent list"
```

---

## Task 13: Build Verification + .gitignore

- [ ] **Step 1: Add `web/dist` and `.superpowers` to `.gitignore`**

Open `.gitignore` and add:

```
web/dist/
web/node_modules/
.superpowers/
```

- [ ] **Step 2: Build the frontend**

```bash
cd web && bun run build
```

Expected: `web/dist/` directory created with `index.html`, `assets/` folder.

- [ ] **Step 3: Start the full stack and verify**

In one terminal:

```bash
WEB_ENABLED=true WEB_PORT=3000 bun run dev
```

In browser open `http://localhost:3000`. Expect:

- App shell loads with bottom nav
- Chat tab shows (may show empty if no active session)
- Sessions tab loads session list from `/api/sessions`
- Status tab shows CPU/mem/disk gauges
- Agents tab shows spawn form

- [ ] **Step 4: Run all tests**

```bash
bun run test
```

Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: add web/dist and .superpowers to .gitignore"
```

---

## Task 14: Bot Emits to SessionEventBus

**Files:**

- Modify: `src/handlers/streaming.ts`

The Grammy bot's streaming handler currently creates status callbacks that only update Telegram messages. Wire it to also emit to `globalEventBus` so Mini App clients see live output from bot-initiated queries.

- [ ] **Step 1: Identify `createStatusCallback` in `src/handlers/streaming.ts`**

Find the `createStatusCallback` export (it returns a `StatusCallback` function). Its inner function already calls things like `editMessage`. After each meaningful event dispatch, also call `globalEventBus.emit(sessionId, { type, content, segmentId })`.

- [ ] **Step 2: Modify `createStatusCallback` to also emit to `globalEventBus`**

At the top of `src/handlers/streaming.ts`, add these two imports after the existing imports:

```typescript
import { globalEventBus } from "../web/sse";
import { getActiveSession } from "../sessions";
```

Inside `createStatusCallback` (line ~314), the returned function starts with:

```typescript
return async (statusType: string, content: string, segmentId?: number) => {
  try {
    if (statusType === "thinking") {
```

Add the bus emit as the **first statement** inside the `try` block, before the existing `if (statusType === "thinking")` check:

```typescript
return async (statusType: string, content: string, segmentId?: number) => {
  try {
    // Emit to Mini App SSE clients
    const activeSess = getActiveSession();
    if (activeSess?.id) {
      globalEventBus.emit(activeSess.id, {
        type: statusType as any,
        content,
        segmentId,
      });
    }

    if (statusType === "thinking") {
      // ... rest of existing code unchanged
```

- [ ] **Step 3: Run all tests**

```bash
bun run test
```

Expected: all pass (streaming tests mock the Telegram API; globalEventBus emits are fire-and-forget and won't break existing tests)

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/handlers/streaming.ts
git commit -m "feat: emit bot streaming events to SessionEventBus for Mini App"
```
