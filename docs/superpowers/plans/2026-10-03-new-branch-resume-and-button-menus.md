# /new --branch, /new --resume, and button-based menus — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a phone user fork or resume a Claude Code conversation into a new desktop session, and drive `/new` and `/claude` (and later other argument-taking commands) through tappable, progressive Telegram menus instead of typing ids and paths.

**Architecture:** (1) Spawn plumbing gains an options object that turns into extra CLI args (`--resume <id> [--fork-session]`) carried to the launch script via the `CLAUDE_RELAY_ARGS` env it already honours. (2) A single reusable menu component (`src/menus/`) renders titled, paged inline keyboards whose buttons carry short tokens (Telegram caps callback data at 64 bytes) resolved from an in-memory TTL registry; suppliers (folder browser, live-session picker, transcript picker, Claude command list) feed it. (3) `/new` with no args and `/claude` with no args open menus; taps call the same functions the typed forms call.

**Tech Stack:** Bun, TypeScript, grammY (`InlineKeyboard`, `callback_query:data`), tmux-based launch script (`scripts/claude-relay-launch.sh`), bun:test.

**Spec:** The Telegram discussion of 2026-10-03 08:40–08:49 (this plan's header + Global Constraints restate it; no separate spec file).

## Global Constraints

- Telegram `callback_data` ≤ 64 bytes → buttons carry `menu:<token>`; paths/ids live only in the registry.
- Never resume a session id that already has a live relay port file (two processes would write one transcript). `--branch` forks (`--fork-session`), so it is exempt.
- `/claude` menu must apply `CLAUDE_COMMAND_BLOCKLIST` (no `exit`/`quit`).
- Folder browser only shows directories under `ALLOWED_PATHS`; hides dot-dirs, `node_modules`, `__pycache__`, `.git`.
- Spawns go through `spawnDesktopClaudeSession` so the relay/topic/watch wiring is unchanged.
- Tests: `bun run test` (isolated per file). Never rely on bare `bun test` totals.
- Commit style: no "Generated with" footers; `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer.

## Review Focus

1. `/new --resume <id>` where `<id>` is live → must refuse with a clear message (Task 2 test `refuses --resume for a live session id`).
2. Menu token expired (bot restarted or TTL passed) → tap must answer "Menu expired, run the command again", never crash or act on a wrong path (Task 4 test `expired token answers callback and does nothing`).
3. Folder browser Up at an allowed root → must not escape the root; Up hidden at roots (Task 5 test `cannot browse above an allowed root`).
4. `/claude` menu tap on a blocklisted name (crafted callback) → refused (Task 7 test `blocklisted command token is refused`).
5. Passthrough Enter swallowed by autocomplete popup → second Enter only when the typed slash command still sits in the input bar; never into a dialog (Task 8 tests).

---

### Task 1: Spawn options → extra CLI args

**Files:**
- Modify: `src/handlers/commands/terminal-launchers.ts` (`buildDesktopShellCommand`)
- Modify: `src/handlers/commands/spawn.ts` (`spawnDesktopClaudeSession` signature + status text)
- Test: `src/__tests__/spawn-options.test.ts` (new)

**Interfaces:**
- Produces: `export interface SpawnOptions { resumeSessionId?: string; fork?: boolean }`
  `buildDesktopShellCommand(explicitPath: string, claudePath: string, opts?: SpawnOptions): string`
  `spawnDesktopClaudeSession(api, chatId, explicitPath, userId, opts?: SpawnOptions): Promise<void>`
  `export function spawnExtraArgs(opts?: SpawnOptions): string[]` → `[]`, `["--resume", id]`, or `["--resume", id, "--fork-session"]`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/spawn-options.test.ts
import { describe, test, expect } from "bun:test";
import { spawnExtraArgs, buildDesktopShellCommand } from "../handlers/commands/terminal-launchers";

describe("spawnExtraArgs", () => {
  test("no options → no args", () => expect(spawnExtraArgs()).toEqual([]));
  test("resume", () => expect(spawnExtraArgs({ resumeSessionId: "abc" })).toEqual(["--resume", "abc"]));
  test("branch = resume + fork", () =>
    expect(spawnExtraArgs({ resumeSessionId: "abc", fork: true })).toEqual(["--resume", "abc", "--fork-session"]));
  test("fork without an id is ignored", () => expect(spawnExtraArgs({ fork: true })).toEqual([]));
});

describe("buildDesktopShellCommand with options", () => {
  test("template path: prefixes CLAUDE_RELAY_ARGS with defaults + extras", () => {
    const cmd = buildDesktopShellCommand("/p/x", "/bin/claude", { resumeSessionId: "abc", fork: true },
      { template: "/s/launch.sh {dir}", defaultArgs: "--a --b" });
    expect(cmd).toBe("CLAUDE_RELAY_ARGS='--a --b --resume abc --fork-session' /s/launch.sh '/p/x'");
  });
  test("template path, no options: unchanged", () => {
    expect(buildDesktopShellCommand("/p/x", "/bin/claude", undefined, { template: "/s/launch.sh {dir}", defaultArgs: "--a" }))
      .toBe("/s/launch.sh '/p/x'");
  });
  test("direct path: appends extras after default args", () => {
    expect(buildDesktopShellCommand("/p/x", "/bin/claude", { resumeSessionId: "abc" }, { template: "", defaultArgs: "--a" }))
      .toBe("cd '/p/x' && exec '/bin/claude' --a --resume abc");
  });
});
```

- [ ] **Step 2: Run it** — `bun test src/__tests__/spawn-options.test.ts` → FAIL (`spawnExtraArgs` not exported).

- [ ] **Step 3: Implement** in `terminal-launchers.ts`:

```ts
export interface SpawnOptions { resumeSessionId?: string; fork?: boolean }

export function spawnExtraArgs(opts?: SpawnOptions): string[] {
  if (!opts?.resumeSessionId) return [];
  const a = ["--resume", opts.resumeSessionId];
  if (opts.fork) a.push("--fork-session");
  return a;
}

export function buildDesktopShellCommand(
  explicitPath: string,
  claudePath: string,
  opts?: SpawnOptions,
  cfg: { template: string; defaultArgs: string } = {
    template: DESKTOP_CLAUDE_COMMAND_TEMPLATE,
    defaultArgs: DESKTOP_CLAUDE_DEFAULT_ARGS,
  },
): string {
  const extras = spawnExtraArgs(opts);
  if (cfg.template) {
    const cmd = cfg.template.replace(/\{dir\}/g, bashSingleQuotedPath(explicitPath));
    if (extras.length === 0) return cmd;
    const relayArgs = [cfg.defaultArgs, ...extras].join(" ");
    return `CLAUDE_RELAY_ARGS=${bashSingleQuotedPath(relayArgs)} ${cmd}`;
  }
  const tail = [cfg.defaultArgs, ...extras].filter(Boolean).join(" ");
  return `cd ${bashSingleQuotedPath(explicitPath)} && exec ${bashSingleQuotedPath(claudePath)} ${tail}`;
}
```

Session ids are UUIDs (validated upstream in Task 2), so they need no quoting inside the single-quoted env value.

In `spawn.ts`: add `opts?: SpawnOptions` as the 5th parameter, pass it to `buildDesktopShellCommand(explicitPath, claudePath, opts)`, and include `resume: opts?.resumeSessionId, fork: !!opts?.fork` in the `spawn: started` log fields. In the "⏳ Terminal opened — starting Claude" status text, when `opts?.resumeSessionId` is set append `\n🔀 Branching from <code>${id.slice(0,8)}</code>` (fork) or `\n▶️ Resuming <code>${id.slice(0,8)}</code>`.

- [ ] **Step 4: Run** `bun test src/__tests__/spawn-options.test.ts` → PASS; `bunx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(spawn): carry --resume/--fork-session into desktop spawns`.

---

### Task 2: `/new --branch` and `/new --resume <id> [path]`

**Files:**
- Modify: `src/handlers/commands/sessions.ts` (`handleNew` → `handleNew(ctx, sctx?)`, new `parseNewArgs`)
- Modify: `src/bot.ts:308` → `bot.command("new", withSctx(handleNew));`
- Modify: `src/handlers/commands/helpers.ts` help text (General section: `/new [path] | --branch | --resume <id> [path]`)
- Test: `src/__tests__/commands.test.ts` ("commands: /new" block) + `src/__tests__/new-args.test.ts` (new, pure parser)

**Interfaces:**
- Produces: `export function parseNewArgs(text: string): { path?: string; resume?: string; branch: boolean; error?: string }`
- Consumes: `SpawnOptions`, `spawnDesktopClaudeSession(..., opts)` from Task 1; `scanPortFiles` from `../../relay`.

- [ ] **Step 1: Parser tests** (`new-args.test.ts`):

```ts
import { describe, test, expect } from "bun:test";
import { parseNewArgs } from "../handlers/commands/sessions";
const ID = "62d0fa2e-bee6-4068-96fe-b41c96d6ce18";
describe("parseNewArgs", () => {
  test("bare", () => expect(parseNewArgs("/new")).toEqual({ branch: false }));
  test("path", () => expect(parseNewArgs("/new ~/p/x")).toEqual({ branch: false, path: "~/p/x" }));
  test("--branch", () => expect(parseNewArgs("/new --branch")).toEqual({ branch: true }));
  test("--resume id path", () => expect(parseNewArgs(`/new --resume ${ID} ~/p`)).toEqual({ branch: false, resume: ID, path: "~/p" }));
  test("-r alias", () => expect(parseNewArgs(`/new -r ${ID}`)).toEqual({ branch: false, resume: ID }));
  test("--resume without id", () => expect(parseNewArgs("/new --resume").error).toContain("session id"));
  test("--resume bad id", () => expect(parseNewArgs("/new --resume nope").error).toContain("session id"));
  test("--branch with --resume", () => expect(parseNewArgs(`/new --branch --resume ${ID}`).error).toContain("either"));
  test("unknown flag", () => expect(parseNewArgs("/new --wat").error).toContain("--wat"));
});
```

- [ ] **Step 2: Run** → FAIL (not exported).

- [ ] **Step 3: Implement** in `sessions.ts`:

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseNewArgs(text: string): { path?: string; resume?: string; branch: boolean; error?: string } {
  const toks = text.trim().split(/\s+/).slice(1);
  let path: string | undefined, resume: string | undefined, branch = false;
  const rest: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t === "--branch" || t === "-b") branch = true;
    else if (t === "--resume" || t === "-r") {
      const id = toks[++i];
      if (!id || !UUID_RE.test(id)) return { branch, error: "--resume needs a session id (uuid)." };
      resume = id;
    } else if (t.startsWith("-")) return { branch, error: `Unknown flag ${t}.` };
    else rest.push(t);
  }
  if (branch && resume) return { branch, resume, error: "Use either --branch or --resume, not both." };
  if (rest.length) path = rest.join(" ");
  return { branch, ...(resume ? { resume } : {}), ...(path ? { path } : {}) };
}
```

`handleNew(ctx, sctx?)`:
1. `const args = parseNewArgs(text)`; on `args.error` → `busReply(ctx, "❌ " + error + "\nUsage: /new [path] | /new --branch | /new --resume <id> [path]")`.
2. `--branch`: requires `sctx?.sessionId && sctx.source === "cc"` else reply "❌ Run /new --branch inside the session topic you want to fork." Path defaults to `sctx.sessionDir`; opts `{ resumeSessionId: sctx.sessionId, fork: true }`.
3. `--resume`: live-guard — `const live = (await scanPortFiles(true)).find(pf => pf.sessionId === args.resume)`; if live → "❌ That conversation is already running in <b>name</b>. Use /new --branch there to fork it." Path defaults: in a topic `sctx.sessionDir`, else the transcript's cwd if `findTranscriptCwd(id)` (read `cwd` from the first JSONL line under `~/.claude/projects/*/<id>.jsonl`; export from `src/sessions/offline.ts` as `export async function findTranscriptCwd(sessionId: string): Promise<string | null>`), else `getWorkingDir()`.
4. Existing path/allow-list/dir checks unchanged; spawn with opts. Status bubble: "🚀 Spawning desktop session…" + "🔀 branching from <b>name</b>" / "▶️ resuming <code>id8</code>".

- [ ] **Step 4: Handler tests** in `commands.test.ts` (inside `describe("commands: /new")`, using the existing `bunSpawnSyncSpy` + `createMockContext`):
  - `refuses --branch outside a topic` → reply contains "inside the session topic", spawn not called.
  - `--branch in a topic spawns with resume+fork` → `mock.module("../handlers/commands/spawn", ...)` capture opts; expect `{ resumeSessionId: "sid", fork: true }` and dir = sctx.sessionDir.
  - `refuses --resume for a live session id` → mock `scanPortFiles` returning a port file with that id; reply contains "already running".
  - `--resume for a dormant id spawns with resume` → opts `{ resumeSessionId: ID }`, no fork.
- [ ] **Step 5: Run** `bun test src/__tests__/new-args.test.ts src/__tests__/commands.test.ts` → PASS; tsc clean.
- [ ] **Step 6: Commit** `feat(new): --branch forks the current session, --resume <id> resumes a dormant one`.

---

### Task 3: `/sessions ▶️ Resume` actually resumes

**Files:**
- Modify: `src/sessions/offline.ts` (`OfflineSession` gains `sessionId: string` = newest JSONL basename)
- Modify: `src/handlers/callback.ts:563-588` (`sess_resume:` passes `{ resumeSessionId: s.sessionId }`)
- Test: `src/__tests__/offline-sessions.test.ts` (existing or new): `listOfflineSessions` entries carry `sessionId`.

Today the Resume button spawns a *fresh* session in the folder. With Task 1 it should resume the transcript it displayed.

- [ ] Steps: failing test on `sessionId` presence → implement (`sessionId: basename(newest.path, ".jsonl")`) → pass → wire callback → commit `fix(sessions): Resume button resumes the shown transcript`.

---

### Task 4: Menu component with token registry

**Files:**
- Create: `src/menus/registry.ts`, `src/menus/menu.ts`, `src/menus/index.ts`
- Modify: `src/handlers/callback.ts` — add before the `askuser:` fallthrough:
  ```ts
  if (callbackData.startsWith("menu:")) { await handleMenuCallback(ctx, callbackData.slice(5)); return; }
  ```
- Test: `src/__tests__/menu-registry.test.ts`, `src/__tests__/menu-render.test.ts`

**Interfaces (Produces):**

```ts
// registry.ts
export interface MenuEntry { kind: string; payload: unknown; chatId: number; createdAt: number }
export function putToken(entry: Omit<MenuEntry, "createdAt">, now = Date.now()): string; // 8-char base36 token
export function getToken(token: string, now = Date.now()): MenuEntry | undefined; // undefined when missing/expired (TTL 30 min)
export function _resetMenuRegistryForTests(): void;

// menu.ts
export interface MenuItem { label: string; kind: string; payload: unknown }
export interface MenuSpec { title: string; items: MenuItem[]; page?: number; pageSize?: number; back?: MenuItem; columns?: 1 | 2 }
export function renderMenu(spec: MenuSpec, chatId: number): { text: string; keyboard: InlineKeyboard };
// paging: "‹ Prev" / "Next ›" items of kind "menu.page" with payload { spec: MenuSpec, page }
export type MenuHandler = (ctx: Context, entry: MenuEntry) => Promise<void>;
export function registerMenuKind(kind: string, handler: MenuHandler): void;
export async function handleMenuCallback(ctx: Context, token: string): Promise<void>;
// resolves token → entry; missing → answerCallbackQuery({ text: "Menu expired — run the command again." });
// chatId mismatch → same expiry message; "menu.page" re-renders via editMessageText; otherwise dispatches by kind.
export async function showMenu(ctx: Context, spec: MenuSpec): Promise<void>; // busReply with replyMarkup (threadId preserved)
export async function replaceMenu(ctx: Context, spec: MenuSpec): Promise<void>; // editMessageText on the tapped message
```

- [ ] **Step 1: Registry tests**: token round-trip; expiry at 30 min; `_reset` clears; tokens are unique across 1000 puts; `getToken` on garbage → undefined.
- [ ] **Step 2: Render tests**: 3 items → 3 rows (+ no paging); 25 items, pageSize 8 → page 0 has 8 + "Next ›"; page 3 has 1 + "‹ Prev"; `back` renders last row; every `callback_data` matches `/^menu:[a-z0-9]{8}$/` and ≤ 64 bytes; `columns: 2` packs two per row.
- [ ] **Step 3: Callback tests** (`handleMenuCallback` with a fake ctx: `answerCallbackQuery`, `editMessageText` spies): expired token answers and does nothing; `menu.page` edits the message; registered kind handler is invoked with the entry; unknown kind answers "Unknown menu action".
- [ ] **Step 4: Implement** (keep each file < 150 lines). Registry: `Map<string, MenuEntry>`; sweep expired entries on each `putToken` when size > 500.
- [ ] **Step 5: Run both test files + tsc; commit** `feat(menus): reusable paged inline-keyboard menu with token registry`.

---

### Task 5: Folder browser supplier

**Files:**
- Create: `src/menus/folder-browser.ts`
- Test: `src/__tests__/folder-browser.test.ts` (uses `mkdtemp` under `/tmp`, which is in the test `ALLOWED_PATHS`)

**Interfaces (Produces):**

```ts
export interface FolderBrowseResult { dir: string; subdirs: string[]; isRoot: boolean }
export async function browseFolder(dir: string | null, roots: string[] = ALLOWED_PATHS): Promise<FolderBrowseResult>;
// dir null → virtual root listing `roots` (isRoot=true, dir=""); hides names starting with "." and node_modules/__pycache__; sorted case-insensitively.
export function parentWithinRoots(dir: string, roots: string[]): string | null; // null when dir is a root (no Up)
export function folderMenuSpec(res: FolderBrowseResult, onPick: { kind: string; payload: (dir: string) => unknown }): MenuSpec;
// items: each subdir → { label: "📁 name", kind: "folder.enter", payload: { dir, onPick } };
// first row when !isRoot: { label: "✅ Open here", kind: onPick.kind, payload: onPick.payload(dir) };
// back: Up → { kind: "folder.enter", payload: { dir: parentWithinRoots(dir) ?? null, onPick } } (omitted at roots)
export function registerFolderMenu(): void; // registers "folder.enter" → replaceMenu(ctx, folderMenuSpec(await browseFolder(dir), onPick))
```

- [ ] Tests: lists only directories; hides dot/node_modules; root listing shows roots as labels with `~` substitution; `parentWithinRoots("/tmp/a/b", ["/tmp/a"])` = `/tmp/a`; `parentWithinRoots("/tmp/a", ["/tmp/a"])` = null; `cannot browse above an allowed root`: `browseFolder("/tmp", ["/tmp/a"])` rejects (throws `outside allowed roots`); 60 subdirs page at 10 per page.
- [ ] Implement, run, commit `feat(menus): folder browser supplier`.

---

### Task 6: `/new` menu (open folder / branch / resume)

**Files:**
- Modify: `src/handlers/commands/sessions.ts` — in `handleNew`, when `parseNewArgs` yields no path/flags **and** the message is from Telegram (not a callback), call `showNewMenu(ctx, sctx)` instead of spawning in the working dir. (The old bare `/new` behaviour moves to the "✅ Open here" button of the default folder.)
- Create: `src/menus/new-menu.ts`
- Modify: `src/index.ts` (or wherever menus get registered at boot): `registerFolderMenu(); registerNewMenu();`
- Test: `src/__tests__/new-menu.test.ts`

**Interfaces:**

```ts
export function newMenuSpec(sctx: SessionContext | undefined, live: SessionInfo[]): MenuSpec;
// items: "📂 Open a folder…" (folder.enter, dir=null, onPick={kind:"new.spawn", payload: dir => ({ dir })})
//        in a topic: "🔀 Branch this session" (new.spawn, { dir: sctx.sessionDir, resume: sctx.sessionId, fork: true })
//        else when live.length: "🔀 Branch a session…" (new.pick-live, { fork: true })
//        "▶️ Resume a conversation…" (new.pick-folder-for-resume → folder.enter with onPick kind "new.pick-transcript")
export function liveSessionsMenuSpec(live: SessionInfo[], fork: boolean): MenuSpec; // each → new.spawn { dir, resume: id, fork }
export async function transcriptsMenuSpec(dir: string): Promise<MenuSpec>;
// lists up to 10 newest JSONLs for dir (reuse getLastSessionMessage from sessions/offline.ts for a 40-char preview + formatTimeAgo), each → new.spawn { dir, resume: id }
export function registerNewMenu(): void; // "new.spawn" → answerCallbackQuery; editMessageText("🚀 Spawning…"); spawnDesktopClaudeSession(ctx.api, chatId, dir, userId, { resumeSessionId: resume, fork })
//                                      // live-guard: resume without fork and id live → answerCallbackQuery({ text: "Already running — branch it instead." })
```

- [ ] Tests: `newMenuSpec` in topic has "Branch this session" with sctx id and fork=true; in General has "Branch a session…" only when live sessions exist; `liveSessionsMenuSpec` payloads; `transcriptsMenuSpec` on a temp project dir with 2 fake JSONLs orders newest first and carries ids; `new.spawn` handler calls spawn with the payload's options (spawn mocked) and refuses a live non-fork resume.
- [ ] Implement, run, tsc, commit `feat(new): button menu — open folder, branch, resume`.

---

### Task 7: `/claude` menu

**Files:**
- Modify: `src/handlers/commands/claude.ts` — `handleClaude` with no arg → `showMenu(ctx, claudeMenuSpec(sctx))` (keep the text reference reachable as `/claude help`).
- Modify: `src/handlers/commands/claude-command-reference.ts` — export the structured list it already has as `CLAUDE_COMMANDS: { group: string; items: { name: string; purpose: string; options?: string[] }[] }[]`; add `options` for `/model` (`["opus", "sonnet", "haiku"]` — labels as Claude accepts them) and `/permissions` (`["default", "acceptEdits", "plan", "bypassPermissions"]`).
- Create: `src/menus/claude-menu.ts`
- Test: `src/__tests__/claude-menu.test.ts`

**Interfaces:**

```ts
export function claudeMenuSpec(sctx?: SessionContext): MenuSpec; // groups as page sections; item kind "claude.cmd" payload { name }; "📖 Reference" item kind "claude.help"
export function claudeOptionsMenuSpec(name: string, options: string[]): MenuSpec; // kind "claude.cmd" payload { name, arg }
export function registerClaudeMenu(): void;
// "claude.cmd": if CLAUDE_COMMAND_BLOCKLIST.has(name) → answerCallbackQuery({ text: "blocked" }) and return;
//               if options exist and no arg → replaceMenu(options spec);
//               else resolve sctx from the callback's thread (resolveSessionContext on a ctx-like with message_thread_id) and call injectSlashCommand(ctx, sctx, `/${name}${arg ? " " + arg : ""}`, `➡️ Sent /${name}.`)
```

`injectSlashCommand` is currently module-private in `src/handlers/commands/inject.ts` — export it.

- [ ] Tests: spec contains no blocklisted names; `blocklisted command token is refused` (handler with a crafted entry `{ name: "exit" }` answers and never calls inject); `/model` tap replaces with options menu; option tap injects `/model opus`; `claude.cmd` outside a topic replies "Use /claude in a Claude session topic."
- [ ] Implement, run, tsc, commit `feat(claude): button menu for passthrough commands`.

---

### Task 8: Passthrough autocomplete retry

**Files:**
- Modify: `src/handlers/commands/terminal-inject.ts` (`sendKeysToTmux`)
- Create: `src/tmux/autocomplete.ts` — `export function inputStillHolds(pane: string, text: string): boolean` (true when some line matches `^\s*[❯>]\s*<escaped text>\s*$`).
- Test: `src/__tests__/tmux-send-guard.test.ts` (extend) + `src/__tests__/tmux-autocomplete.test.ts`

After the first `Enter`, when `text.startsWith("/")`: sleep settle, capture; if `inputStillHolds(pane, text)` and `!isModalPresent(pane)` → send `Enter` once more and set `note: "autocomplete popup dismissed"`. Never more than one retry.

- [ ] Tests: `inputStillHolds` true for `"❯ /branch"`, false for `"❯ "` and for a different command; `sendKeysToTmux` fake IO with captures `[idle, typed, stillTyped, done]` → sends `["-l","/branch"], ["Enter"], ["Enter"]`; with captures `[idle, typed, done]` → one Enter; a modal after the first Enter → no second Enter and `blocked`.
- [ ] Implement, run, commit `fix(inject): press Enter again when Claude's command autocomplete swallows it`.

---

### Task 9: Docs, help, review, PR

- [ ] `helpers.ts` help text: `/new` line → `/new — pick a folder, branch or resume (buttons); /new [path] | --branch | --resume <id>`; `/claude` line → `/claude — command menu; /claude <cmd> sends it`.
- [ ] `docs/` : add `docs/menus.md` (how to add a supplier: MenuSpec, kinds, registry TTL, 64-byte rule) and update `README.md` command table.
- [ ] `bun run test` green; `bunx tsc --noEmit` clean; `bash scripts/claude-relay-launch.test.sh` unchanged.
- [ ] In-house `/code-review <branch> medium`; address findings.
- [ ] Open PR `feat(bot): /new --branch & --resume, button menus for /new and /claude`; needs the owner's Approve before merge (code-owner rule).

---

## Self-review notes

- Spec coverage: fork (T1+T2), resume (T1+T2+T3), duplicate guard (T2+T6), 64-byte tokens (T4), folder browser (T5), `/new` menu (T6), `/claude` menu incl. sub-options (T7), autocomplete (T8), docs (T9). Sweep of other commands (`/cd`, `/ralph`, `/rename` suggestions) is intentionally **out of scope** for this PR — the component makes it a follow-up.
- Type consistency: `SpawnOptions` is defined once in `terminal-launchers.ts` and imported by `spawn.ts`, `sessions.ts`, `new-menu.ts`. Menu kinds: `menu.page`, `folder.enter`, `new.spawn`, `new.pick-live`, `new.pick-transcript`, `claude.cmd`, `claude.help`.
