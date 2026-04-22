# Chat Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web Chat tab match the Telegram side — replay session history on open, and render markdown/HTML instead of raw source.

**Architecture:** New backend route `GET /api/sessions/:id/history` reads the session's JSONL transcript and maps each user/assistant entry to the same `SseEvent` shape the live stream already uses. Frontend `ChatPage` seeds state from history then subscribes to the live stream. `Terminal.tsx` renders content through `marked` (for text/markdown) or as HTML (for tool/thinking), both sanitized with `DOMPurify`.

**Tech Stack:** Bun, TypeScript, Hono, React 18, `marked`, `dompurify`.

**Spec:** [`docs/superpowers/specs/2026-04-19-chat-parity-design.md`](../specs/2026-04-19-chat-parity-design.md)

---

## File Map

**New backend files:**

- `src/web/sessions/history.ts` — `readSessionHistory(sessionId, limit)` and entry→events mapping
- `src/__tests__/web-sessions-history.test.ts` — fixture-driven tests

**Modified backend files:**

- `src/web/routes/sessions.ts` — add `GET /:id/history` handler
- `src/web/tasks/reader.ts` — export `findSessionJsonl` (internal helper today) so `history.ts` reuses it

**Modified frontend files:**

- `web/src/api.ts` — add `getSessionHistory`
- `web/src/pages/ChatPage.tsx` — fetch history before subscribing to stream
- `web/src/components/Terminal.tsx` — render via `marked` + `DOMPurify`
- `web/package.json` — add `marked`, `dompurify`, `@types/dompurify`

**New frontend test file:**

- `web/src/__tests__/Terminal.test.tsx` — rendering assertions

---

## Task 1: Export `findSessionJsonl` from reader

**Files:**

- Modify: `src/web/tasks/reader.ts`

- [ ] **Step 1: Change the function to be exported**

Open `src/web/tasks/reader.ts`. Find `async function findSessionJsonl(...)` (currently not exported). Change it to `export async function findSessionJsonl(...)`. No other change.

- [ ] **Step 2: Typecheck + existing tests**

```bash
bun run typecheck && bun test src/__tests__/web-tasks-reader.test.ts
```

Expected: typecheck clean, 6 reader tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/web/tasks/reader.ts
git commit -m "refactor(tasks): export findSessionJsonl for reuse"
```

---

## Task 2: History reader — types + pure function

**Files:**

- Create: `src/web/sessions/history.ts`
- Create: `src/__tests__/web-sessions-history.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/web-sessions-history.test.ts`:

```ts
import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "sess-history-"));
  process.env.CLAUDE_DIR = TMP;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.CLAUDE_DIR;
});

async function load() {
  return import("../web/sessions/history");
}

function writeFixture(sessionId: string, lines: unknown[]): void {
  const projectsDir = join(TMP, "projects", "-Users-x-proj");
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(
    join(projectsDir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

describe("readSessionHistory", () => {
  test("returns empty array when JSONL is missing", async () => {
    const { readSessionHistory } = await load();
    const events = await readSessionHistory("missing-sid", 100);
    expect(events).toEqual([]);
  });

  test("maps a user string message to a prefixed text event", async () => {
    const sid = "sid-user-string";
    writeFixture(sid, [
      { type: "user", message: { role: "user", content: "hello" } },
    ]);
    const { readSessionHistory } = await load();
    const events = await readSessionHistory(sid, 100);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "text", content: "› hello" });
  });

  test("skips user tool_result messages", async () => {
    const sid = "sid-tool-result";
    writeFixture(sid, [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }],
        },
      },
    ]);
    const { readSessionHistory } = await load();
    const events = await readSessionHistory(sid, 100);
    expect(events).toEqual([]);
  });

  test("maps assistant text, thinking, and tool_use blocks", async () => {
    const sid = "sid-assist";
    writeFixture(sid, [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "pondering" },
            { type: "text", text: "Hello **there**" },
            { type: "tool_use", name: "Read", input: { file_path: "/a" } },
          ],
        },
      },
    ]);
    const { readSessionHistory } = await load();
    const events = await readSessionHistory(sid, 100);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "thinking", content: "pondering" });
    expect(events[1]).toMatchObject({
      type: "text",
      content: "Hello **there**",
    });
    expect(events[2]!.type).toBe("tool");
    expect(events[2]!.content).toContain("Read"); // formatted tool string
  });

  test("ignores noise entries (attachment, permission-mode, malformed)", async () => {
    const sid = "sid-noise";
    const path = join(TMP, "projects", "-p");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, `${sid}.jsonl`),
      [
        JSON.stringify({ type: "permission-mode" }),
        JSON.stringify({ type: "attachment" }),
        "not json {",
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "kept" },
        }),
      ].join("\n") + "\n",
    );
    const { readSessionHistory } = await load();
    const events = await readSessionHistory(sid, 100);
    expect(events).toHaveLength(1);
    expect(events[0]!.content).toBe("› kept");
  });

  test("caps to the last N events when limit is exceeded", async () => {
    const sid = "sid-limit";
    const lines = Array.from({ length: 50 }, (_, i) => ({
      type: "user",
      message: { role: "user", content: `msg${i}` },
    }));
    writeFixture(sid, lines);
    const { readSessionHistory } = await load();
    const events = await readSessionHistory(sid, 10);
    expect(events).toHaveLength(10);
    expect(events[0]!.content).toBe("› msg40");
    expect(events[9]!.content).toBe("› msg49");
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

```bash
bun test src/__tests__/web-sessions-history.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement the history reader**

Create `src/web/sessions/history.ts`:

```ts
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { findSessionJsonl } from "../tasks/reader";
import type { SseEvent } from "../sse";
import { formatToolStatus } from "../../formatting";
import { warn } from "../../logger";

interface JsonlEntry {
  type?: string;
  message?: {
    role?: "user" | "assistant";
    content?: string | unknown[];
  };
}

interface AssistantBlock {
  type: "text" | "thinking" | "tool_use";
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
}

function getClaudeDir(): string {
  return process.env.CLAUDE_DIR || `${process.env.HOME}/.claude`;
}

function mapUserEntry(entry: JsonlEntry): SseEvent[] {
  const content = entry.message?.content;
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", content: `› ${content}` }] : [];
  }
  if (!Array.isArray(content)) return [];
  const events: SseEvent[] = [];
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block.type === "text" && typeof block.text === "string") {
      events.push({ type: "text", content: `› ${block.text}` });
    }
    // tool_result intentionally skipped
  }
  return events;
}

function mapAssistantEntry(entry: JsonlEntry, turnIdx: number): SseEvent[] {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  const events: SseEvent[] = [];
  let textSegment = 0;
  for (const raw of content as AssistantBlock[]) {
    if (raw.type === "thinking" && raw.thinking) {
      events.push({ type: "thinking", content: raw.thinking });
    } else if (
      raw.type === "text" &&
      typeof raw.text === "string" &&
      raw.text.length > 0
    ) {
      events.push({
        type: "text",
        content: raw.text,
        segmentId: turnIdx * 100 + textSegment,
      });
      textSegment += 1;
    } else if (raw.type === "tool_use" && raw.name) {
      const input = (raw.input ?? {}) as Record<string, unknown>;
      events.push({
        type: "tool",
        content: formatToolStatus(raw.name, input),
      });
    }
  }
  return events;
}

export async function readSessionHistory(
  sessionId: string,
  limit: number,
): Promise<SseEvent[]> {
  const jsonl = await findSessionJsonl(getClaudeDir(), sessionId);
  if (!jsonl) return [];

  const all: SseEvent[] = [];
  let turnIdx = 0;

  const stream = createReadStream(jsonl, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: JsonlEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "user" && entry.message?.role === "user") {
        all.push(...mapUserEntry(entry));
      } else if (
        entry.type === "assistant" &&
        entry.message?.role === "assistant"
      ) {
        all.push(...mapAssistantEntry(entry, turnIdx));
        turnIdx += 1;
      }
    }
  } catch (err) {
    warn(`history: failed reading ${jsonl}: ${(err as Error).message}`);
  } finally {
    rl.close();
    stream.close();
  }

  return all.length <= limit ? all : all.slice(all.length - limit);
}
```

- [ ] **Step 4: Run tests — verify green**

```bash
bun test src/__tests__/web-sessions-history.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/sessions/history.ts src/__tests__/web-sessions-history.test.ts
git commit -m "feat(sessions): add history reader for Claude Code JSONL transcripts"
```

---

## Task 3: History route

**Files:**

- Modify: `src/web/routes/sessions.ts`

- [ ] **Step 1: Add the route**

Open `src/web/routes/sessions.ts`. Add an import near the other imports:

```ts
import { readSessionHistory } from "../sessions/history";
```

In `createSessionsRouter()`, after `app.get("/:id/stream", ...)` and before the `app.post("/:id/message", ...)` route, add:

```ts
app.get("/:id/history", async (c) => {
  const sessionId = c.req.param("id");
  const limit = parseInt(c.req.query("limit") ?? "200", 10);
  const events = await readSessionHistory(
    sessionId,
    Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : 200,
  );
  return c.json({ events });
});
```

- [ ] **Step 2: Typecheck + full backend suite**

```bash
bun run typecheck && bun run test
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/web/routes/sessions.ts
git commit -m "feat(sessions): expose GET /api/sessions/:id/history"
```

---

## Task 4: Frontend — `api.getSessionHistory` + `ChatPage` wiring

**Files:**

- Modify: `web/src/api.ts`
- Modify: `web/src/pages/ChatPage.tsx`

- [ ] **Step 1: Add API client method**

In `web/src/api.ts`, inside the `api` object, add (keep comma placement correct):

```ts
  async getSessionHistory(
    sessionId: string,
    limit = 200,
  ): Promise<SseEvent[]> {
    const res = await fetch(
      `${BASE}/sessions/${sessionId}/history?limit=${limit}`,
      { headers: headers() },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { events: SseEvent[] };
    return body.events;
  },
```

- [ ] **Step 2: Seed history in `ChatPage`**

Open `web/src/pages/ChatPage.tsx`. Replace the `useEffect` that keys on `[activeId]` with:

```tsx
useEffect(() => {
  if (!activeId) return;
  unsubRef.current?.();

  let cancelled = false;
  (async () => {
    try {
      const hist = await api.getSessionHistory(activeId);
      if (!cancelled) setEvents(hist);
    } catch {
      if (!cancelled) setEvents([]);
    }
  })();

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

  return () => {
    cancelled = true;
    unsub();
  };
}, [activeId]);
```

- [ ] **Step 3: Typecheck + build**

```bash
cd web && bunx tsc --noEmit && bun run build && cd ..
```

Expected: no errors, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/api.ts web/src/pages/ChatPage.tsx
git commit -m "feat(web): seed ChatPage with session history on mount"
```

---

## Task 5: Install `marked` + `dompurify` and update `Terminal`

**Files:**

- Modify: `web/package.json`
- Modify: `web/src/components/Terminal.tsx`

- [ ] **Step 1: Install**

```bash
cd web && bun add marked dompurify && bun add -d @types/dompurify && cd ..
```

- [ ] **Step 2: Update `Terminal.tsx`**

Replace the contents of `web/src/components/Terminal.tsx` with:

```tsx
import { useEffect, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
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

function renderHtml(evt: SseEvent): { __html: string } {
  try {
    if (evt.type === "text") {
      const html = marked.parse(evt.content, {
        async: false,
        breaks: true,
      }) as string;
      return { __html: DOMPurify.sanitize(html) };
    }
    return { __html: DOMPurify.sanitize(evt.content) };
  } catch {
    // Fall back to escaped plain text so the UI never breaks
    const escaped = evt.content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return { __html: escaped };
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
            <span dangerouslySetInnerHTML={renderHtml(evt)} />
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

- [ ] **Step 3: Typecheck + build**

```bash
cd web && bunx tsc --noEmit && bun run build && cd ..
```

Expected: no errors, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/package.json web/bun.lock web/src/components/Terminal.tsx
git commit -m "feat(web): render markdown + HTML in Terminal via marked + DOMPurify"
```

---

## Task 6: Terminal rendering tests

**Files:**

- Create: `web/src/__tests__/Terminal.test.tsx`

- [ ] **Step 1: Write the tests**

Create `web/src/__tests__/Terminal.test.tsx`:

```tsx
import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { Terminal } from "../components/Terminal";
import type { SseEvent } from "../api";

describe("Terminal", () => {
  test("renders markdown bold inside text events as <strong>", () => {
    const events: SseEvent[] = [{ type: "text", content: "hello **there**" }];
    const { container } = render(
      <Terminal events={events} streaming={false} />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("there");
  });

  test("renders HTML inside tool events without escaping", () => {
    const events: SseEvent[] = [
      { type: "tool", content: "<b>Read:</b> foo.txt" },
    ];
    const { container } = render(
      <Terminal events={events} streaming={false} />,
    );
    const bold = container.querySelector("b");
    expect(bold?.textContent).toBe("Read:");
  });

  test("renders thinking HTML with italic class on parent", () => {
    const events: SseEvent[] = [
      { type: "thinking", content: "pondering <b>deeply</b>" },
    ];
    const { container } = render(
      <Terminal events={events} streaming={false} />,
    );
    expect(container.querySelector(".italic")).not.toBeNull();
    expect(container.querySelector("b")?.textContent).toBe("deeply");
  });

  test("skips done and segment_end events", () => {
    const events: SseEvent[] = [
      { type: "text", content: "shown" },
      { type: "done", content: "" },
      { type: "segment_end", content: "" },
    ];
    const { container } = render(
      <Terminal events={events} streaming={false} />,
    );
    // Only one renderable event div (plus the bottom-ref spacer)
    const paras = container.querySelectorAll("div > span[class]");
    expect(paras.length).toBeGreaterThan(0);
    expect(container.textContent).toContain("shown");
  });

  test("strips <script> via DOMPurify", () => {
    const events: SseEvent[] = [
      { type: "tool", content: `<b>ok</b><script>window.x=1</script>` },
    ];
    const { container } = render(
      <Terminal events={events} streaming={false} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")?.textContent).toBe("ok");
  });
});
```

- [ ] **Step 2: Run**

```bash
cd web && bun run test && cd ..
```

Expected: 5 passing tests.

- [ ] **Step 3: Commit**

```bash
git add web/src/__tests__/Terminal.test.tsx
git commit -m "test(web): assert Terminal renders markdown/HTML safely"
```

---

## Task 7: Manual verification

**Files:** none (verification only)

- [ ] **Step 1: Restart the bot**

```bash
./restart.sh
```

Expected: launchctl restarts the bridge with the new backend route.

- [ ] **Step 2: Open the Mini App via `/app` in Telegram**

Open Chat tab for a session that has prior Telegram history.

Expected:

- Previous user and assistant messages appear immediately (up to 200 most recent events).
- Markdown bold/italic/code renders with proper formatting — no stray `**` or backticks.
- Tool calls show with bold tool names and emoji, not raw `<b>` tags.
- Live streaming continues to append after history.

- [ ] **Step 3: Smoke-test**

Send a message from Telegram. It should appear in the web Chat tab within a second.
Send a message from the web. It should appear in Telegram.

---

## Acceptance criteria

- `bun run typecheck` clean
- `bun run test` clean (backend; including 6 new history tests)
- `cd web && bun run test` clean (frontend; 5 new Terminal tests, existing 5 KanbanBoard tests)
- Web Chat tab shows recent transcript on open
- Bold/italic/code/tool-badges render correctly — no raw markup visible
- Live streaming still works end-to-end in both directions
