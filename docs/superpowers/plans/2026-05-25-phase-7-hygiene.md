# Phase 7 — Hygiene

**Goal:** Clean up the small rot that's accumulated. Half-day's work, very low risk, but the codebase ages better afterwards.

**Estimated effort:** 0.5 day.

**Branch:** `refactor/phase-7-hygiene`

**Dependencies:** None.

## Item 1 — Legacy topic-store path

`src/topics/topic-store.ts` still references `/tmp/claude-telegram-topics.json` as a legacy migration path. Production data has long since moved to `~/.claude-mobile-bridge/topics.json`.

**Action:** delete the legacy path + migration. Add a one-time check at startup: if the legacy file still exists and primary doesn't, error loudly with instructions. Don't auto-migrate any more.

## Item 2 — `console.log` escapes

`grep -rEn "console\.(log|warn|error)" src --include="*.ts"` returns 9 hits in production code. Each is a leak from debugging that wasn't reverted.

**Action:** replace with `logger.{debug,info,warn,error}`. If a site genuinely shouldn't log in production, delete it.

## Item 3 — `any` types

9 sites use `: any` or `as any`. Each is a deferred typing decision.

**Action:** narrow to the actual shape. If genuinely heterogeneous, use `unknown` + a type predicate. If three-of-the-nine are protocol boundaries (e.g., `Record<string, unknown>` from JSON.parse), that's fine — just convert from `any` to `unknown`.

## Item 4 — TCP backpressure

`src/relay/client.ts:210` does `socket.write(JSON.stringify(msg) + "\n")` and returns `true` on the synchronous success of the call — but if Node's buffer is filling (slow consumer), `socket.write` returns `false` and we're supposed to wait for `drain`. We don't.

**Action:** track `socket.write`'s return value; if `false`, await `drain` before the next write. Apply same fix in `src/mcp/channel-relay/server.ts` for the bot-bound direction. Add a test that simulates a slow consumer and verifies in-order delivery without OOM.

## Item 5 — Unused exports / dead files

A quick `tsc --noEmit --traceResolution` + `ts-prune` pass (or manual ripgrep) often finds 5–10 unused exports across a codebase this size.

**Action:** delete confirmed-unused exports and any orphan files. (Verify nothing in `web/src/` imports them — the web bundle is a separate compilation unit.)

## Item 6 — `.vscode/` directory

There's an untracked `.vscode/` dir locally. Decide:

- If team-shared settings, commit `.vscode/settings.json` and add `.vscode/launch.json` to `.gitignore`
- If purely personal, add the whole `.vscode/` to `.gitignore`

## Stepwise approach

All items are independent. Land them as separate small commits within one PR. Order doesn't matter. Each item is 30–60 min.

## Acceptance criteria

- `grep -rEn "console\.(log|warn|error)" src --include="*.ts" | grep -v __tests__ | grep -v __mocks__` returns 0 lines
- `grep -rEn ":\s*any\b|as\s*any\b" src --include="*.ts" | grep -v __tests__ | grep -v __mocks__` returns 0 lines
- Legacy topic-store migration path deleted; primary path is the only one in code
- `client.ts` handles `socket.write === false` with `drain` event
- `.vscode/` is either committed or gitignored — no untracked state
- All tests still pass

## Risks

- Minimal. Item 4 (backpressure) is the only one with real-world implications; rest is paint.

## Out of scope

- Dependency upgrades — separate cycle, separate risk
- Migration to ESM-style `node:` imports (already done in most files)
- Renaming directories for clarity
