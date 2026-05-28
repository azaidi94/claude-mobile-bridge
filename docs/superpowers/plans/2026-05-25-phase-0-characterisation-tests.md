# Phase 0 — Characterisation tests

**Goal:** Lock down current behaviour of the 5 happy paths we use daily, so phases 1+ can't silently change them. End-to-end-ish — real handlers, mock TG/relay boundaries.

**Estimated effort:** 1 day.

**Branch:** `refactor/phase-0-characterisation`

## What's covered today (snapshot)

`bun run test` already runs 64 test files across 898 tests (898 isolated, 169 fail in single-process due to shared module state — not real bugs). Most cover unit-level behaviour: formatting, topic-store, AUQ, watcher, relay discovery, individual command handlers.

What's **NOT** covered today: integrated multi-handler flows. The recent bug class (photo handler using `getActiveSession` instead of `sessionOverride`) had no test catching it because the unit tests mocked at too low a level.

## Approach revision (post-prototyping)

Initial design called for full handler → TCP-relay round-trip integration
tests. In practice, fighting Bun's `mock.module` semantics + production's
`isRelayProcess` ps-check + the relay client's 45s waitForReply timeout
adds friction that buys little extra coverage.

The bug class Phase 1 risks is in **session resolution** — `loadTopicSession`
returning the right `sessionOverride`, handlers picking the right session.
The delivery path itself (TCP relay client → channel-relay server → CC) is
already well-covered by existing unit tests in `relay-discovery.test.ts`,
`relay-selection.test.ts`, etc.

So Phase 0 ships **resolution characterisation tests** rather than full
delivery integration tests. Same regression-detection value for Phase 1;
no test infrastructure churn.

## Scenarios to add

Each scenario gets one test file under `src/__tests__/scenarios/`. Each
exercises the session-resolution layer with realistic topic-store and
session-registry state.

### S1 — `text-to-cc-via-topic.test.ts`

```
Given: a CC session bound to topic 42 in chat -100
       (port file exists, sessionId="cc-uuid-1", dir="/proj/a")
When:  user sends text "hello" to topic 42
Then:  handleText is invoked
       sessionOverride is resolved to cc-uuid-1
       sendViaRelay routes to the correct relay port
       no message lands in any other topic
```

### S2 — `photo-to-cc-via-topic.test.ts`

Same shape as S1 but for `handlePhoto`. Specifically asserts that when _another_ session (e.g. a Cursor topic) was the most-recent activity in `getActiveSession()`, the photo still lands in the topic the user sent it to. This is the regression we just fixed today.

### S3 — `cursor-topic-rejects-photo.test.ts`

```
Given: a Cursor topic bound to "cursor-myproj"
When:  user sends photo
Then:  handlePhoto replies "Photos aren't supported in Cursor topics yet"
       sendViaRelay is NOT invoked
       no CC session gets the photo
```

### S4 — `auq-remote-answer-flow.test.ts`

```
Given: a relay-bridged CC session
       AskUserQuestion fires in the desktop
When:  bot's PreToolUse hook posts to /api/auq-bridge
Then:  card lands in the right TG topic
       user taps an option in TG
       answer routes back through the relay to the right session
       only the first answer (TG vs local) wins
```

### S5 — `relay-reconnect-after-bot-restart.test.ts`

```
Given: a relay running, port file written, no sessionId in it
When:  bot starts (cold)
Then:  backfillPortFileSessionIds writes the missing sessionId
       isRelayAvailable({sessionId}) returns true
       sendViaRelay can deliver a message to that session
```

## Test infrastructure

Add `src/__tests__/scenarios/_helpers.ts` with:

- `makeMockBot()` — grammy `Api` double recording all calls, replaying canned responses
- `makeMockRelay({port, sessionId, cwd})` — TCP server doubling as a relay, accepts/echoes/records
- `withTempStateDir(fn)` — runs `fn` against an isolated `STATE_DIR`, restores afterwards
- `makeContext({chatId, threadId, fromUser, text|photo|voice})` — produces a grammy `Context` for handler tests

## Acceptance criteria

- 5 new scenario tests, all green via `bun run test`
- Each scenario directly executes the production handler (`handleText`, `handlePhoto`, …), not a partial copy
- No `bun:mock`/`jest.mock` voodoo — pure dependency injection via the helpers above
- The test for S2 must fail when reverting today's photo-handler patch — proves it would have caught the bug

## Out of scope (for this phase)

- Web UI integration tests (already covered separately)
- Cursor CDP injection tests (CDP boundary is hard to mock; out of scope here)
- Performance/load tests
