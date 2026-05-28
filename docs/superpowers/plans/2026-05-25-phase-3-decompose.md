# Phase 3 — Decompose the god files

**Goal:** Break apart `commands.ts` (2017 lines) and `watch.ts` (1925 lines) along their existing logical seams. Pure mechanical move — no behaviour change. Each resulting file ≤ 400 lines.

**Estimated effort:** 3 days.

**Branch:** `refactor/phase-3-decompose`

**Dependencies:** Phases 1 and 2. The god files become easier to split once they take explicit `SessionContext` and route sends through the message bus.

## Why

These two files are where most of the bugs we've fixed live, by simple proportion of LOC. They're also where new contributors get lost. Comments inside `watch.ts` reference bug_002, bug_004, bug_012 — accreted complexity, no clean seams to a reader.

Both files **already have** clean seams; they just haven't been extracted.

## commands.ts decomposition

Current: 2017 lines, ~30 slash-command handlers in one file plus their helpers (spawn flow, terminal launchers, cleanzombie, switch flow, settings panel, etc.).

Target layout (under `src/handlers/commands/`):

| New file                | Owns                                                                           | Approx LOC |
| ----------------------- | ------------------------------------------------------------------------------ | ---------- |
| `index.ts`              | Registers each command via `bot.command()`. Imports from siblings.             | ~80        |
| `sessions.ts`           | `/list`, `/new`, `/sessions`, `/kill`, `/respawn`                              | ~350       |
| `control.ts`            | `/stop`, `/retry`, `/status`, `/model`, `/restart`                             | ~300       |
| `files.ts`              | `/pwd`, `/cd`, `/ls`                                                           | ~150       |
| `usage.ts`              | `/usage` (already partially extracted to `handlers/usage.ts` — finish the job) | ~120       |
| `execute.ts`            | `/execute` shell-scripts panel                                                 | ~200       |
| `app.ts`                | `/app` Mini App linker                                                         | ~50        |
| `settings-panel.ts`     | `/settings` panel                                                              | ~300       |
| `cleanzombie.ts`        | `/cleanzombie` and `/cleanzombie sweep`                                        | ~250       |
| `spawn.ts`              | The shared spawn-Claude-in-terminal flow used by `/new` and `/sessions resume` | ~250       |
| `terminal-launchers.ts` | The Terminal.app / iTerm2 / Ghostty / cmux launcher branches                   | ~150       |

Total: ~2200 lines (slight expansion is fine — explicit imports, no churn).

## watch.ts decomposition

Current: 1925 lines doing JSONL tailing + status-message lifecycle + permission-mode banner + hook cards + AUQ handling + dedup + flush timers + drift detection + offline-queue replay.

Target layout (under `src/handlers/watch/`):

| New file               | Owns                                                                                             | Approx LOC |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ---------- |
| `index.ts`             | Public API (`startWatcher`, `stopWatcher`, `isWatching`) + per-(chatId,threadId) state container | ~200       |
| `jsonl-tailer.ts`      | The tailer integration: subscribe to events, drift detection, EOF→head re-anchoring              | ~250       |
| `event-router.ts`      | Dispatches JSONL events to renderers below. Single switch on event.type                          | ~150       |
| `text-renderer.ts`     | Assistant text streaming, markdown wrapping, chunk-edit timing                                   | ~300       |
| `tool-headers.ts`      | Tool-use cards (Edit diff, Bash block, Read, Grep, etc.)                                         | ~250       |
| `tool-results.ts`      | Promoted tool results (Bash/Grep/Agent/WebFetch), errors always                                  | ~200       |
| `permission-banner.ts` | The sticky permission-mode banner                                                                | ~120       |
| `hook-cards.ts`        | Stop-hook block notifications                                                                    | ~80        |
| `status-message.ts`    | (already exists in `sessions/status-message.ts` — verify boundary)                               | —          |
| `dedup.ts`             | The per-segment dedup logic (the bug_002/bug_012 zone)                                           | ~150       |
| `flush-timers.ts`      | AI buffer flush timing and timeouts                                                              | ~120       |
| `offline-queue.ts`     | Bridge-health offline queue replay                                                               | ~150       |

Total: ~1970 lines (essentially the same).

## Stepwise approach

1. **commands.ts first (~1.5 days).** Less interdependence, more pure mechanical extraction.
   - Create `src/handlers/commands/` dir + `index.ts` shell that re-registers all commands.
   - Move one command group at a time, run tests, commit.
   - End: delete the old `commands.ts`.
2. **watch.ts second (~1.5 days).** More state-sharing between segments — go carefully.
   - Identify the per-(chat,thread) `WatchState` object; ensure all the new files take it as a parameter (no module-level mutable state).
   - Move one renderer at a time, verify tests, commit.
   - End: delete the old `watch.ts`.

## Acceptance criteria

- No file under `src/handlers/` exceeds 400 lines (excluding tests)
- `src/handlers/commands.ts` deleted
- `src/handlers/watch.ts` deleted
- `src/handlers/commands/index.ts` registers the same set of commands as before — diff in grammy registrations is `{}`
- All tests still green
- `bun run typecheck` clean
- Manual smoke: every command listed in README "Commands" table works as before

## Risks

- **Hidden mutual state in watch.ts.** Pre-extract scan for `let X;` at module top — every one is a candidate for the per-instance state. The bug stories in its comments hint at where to look.
- **Test files reference specific exports.** Tests may import private helpers. Audit before move.
- **Import cycles.** Likely as soon as you split. Resolve by extracting shared types to `src/handlers/watch/types.ts`.

## Out of scope

- Renaming files for clarity (we want minimal diff, not a renaming spree)
- Logic changes within extracted modules — "if I'm here anyway" temptation. Resist.
- Test re-organisation — tests stay where they are
