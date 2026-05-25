# Clean-architecture refactor — overview

**Branch:** `refactor/clean-architecture` (cut from `main` @ `80e460e`).

**Motivation:** After reviewing ~22k LOC of production code, ~90% of the bug class we've been firefighting (multi-session routing, dual-path sends, silent failures on Cursor topics, the "no desktop session found" false-positives) traces back to a few wrong core abstractions:

1. A **singleton `session` module** holding `sessionId`, `workingDir`, registry loader, plus the streaming SDK wrapper — shared by every handler regardless of which topic/session they're acting in.
2. **`getActiveSession()` as a global most-recent pointer** — bumped by every Cursor CDP nudge, hijacking what "the active session" means in handlers that should be topic-scoped.
3. **No single outbound message bus** — handlers, watch, cursor-bridge, and relay-bridge each have their own paths to Telegram. ~20 direct `ctx.api.sendMessage` calls in handlers alone.
4. **God files** (`commands.ts` 2017 lines, `watch.ts` 1925 lines) where most bugs live.
5. **Heuristic-heavy channel-relay JSONL discovery** that we've patched twice in two days because the abstraction is wrong.
6. **214 try/catch blocks, 17 explicitly empty.** Silent failures hiding real signals.

This refactor is **structural, not behavioural** — features stay, the surface area for users is unchanged. Each phase is shippable independently, gated by tests-still-green.

## Phase order and rationale

| #   | Phase                              | Days | Bug-class it eliminates    |
| --- | ---------------------------------- | ---- | -------------------------- |
| 0   | Characterisation tests             | 1    | Refactor risk              |
| 1   | **Kill the singleton session**     | 2    | Multi-session routing bugs |
| 2   | **Single outbound message bus**    | 2    | Dual-path send bugs        |
| 3   | Decompose god files                | 3    | God-file blast radius      |
| 4   | Relay sessionId via env var        | 1    | Racing JSONL discovery     |
| 5   | Cursor as a Session implementation | 2    | `cursor-*` special-cases   |
| 6   | Error-handling audit + `safeAsync` | 1    | Silent failures            |
| 7   | Hygiene                            | 0.5  | Rot                        |

Total **~12 working days**. Phases 1 and 2 alone eliminate the recurring multi-session and dual-path bug classes — that's where the leverage is.

## Constraints — what we won't do

- **No big-bang rewrite.** The features work. The tests are good. Move incrementally.
- **No framework swap.** Bun + grammy + MCP stack stays. We saw the Go alternative (`cc-connect`); not worth it.
- **No new features mid-refactor.** Discipline matters. Bug fixes that are direct enablers of a phase are OK; novel UX changes wait.
- **No dropping tests.** Each phase lands with green test:isolated.

## How each phase is shipped

Each phase is its own branch off `refactor/clean-architecture`, PR'd back into it. The branch lives until phase 7 lands, then merges to `main` as one. This keeps `main` shippable throughout — at any moment we can abandon the refactor and lose nothing.

## See

- [Phase 0 — Characterisation tests](./2026-05-25-phase-0-characterisation-tests.md)
- [Phase 1 — Kill the singleton session](./2026-05-25-phase-1-session-context.md)
- [Phase 2 — Single outbound message bus](./2026-05-25-phase-2-message-bus.md)
- [Phase 3 — Decompose god files](./2026-05-25-phase-3-decompose.md)
- [Phase 4 — Relay sessionId via env var](./2026-05-25-phase-4-relay-env.md)
- [Phase 5 — Cursor as a Session implementation](./2026-05-25-phase-5-cursor-session.md)
- [Phase 6 — Error handling discipline](./2026-05-25-phase-6-error-handling.md)
- [Phase 7 — Hygiene](./2026-05-25-phase-7-hygiene.md)
