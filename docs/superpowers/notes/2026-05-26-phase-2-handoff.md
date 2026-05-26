# Phase 2 — Complete (2026-05-26)

**Phase 2 is done.** All outbound Telegram traffic flows through one
`MessageBus` (`src/messaging/bus.ts`). Parse-mode resolution, chunking,
plain-fallback, dedup, rate-limiting, and `bus.send` logging live in one
place. The dual-path-send bug class — where two code paths each thought
they owned a reply — is no longer possible for any text/keyboard send.

## Branches

```
main
└── refactor/clean-architecture
    └── refactor/phase-2-message-bus   ✅ ready to PR back into refactor/clean-architecture
        ├── 0ed38e1 — add MessageBus + format helpers (step 1)
        ├── 5a65ca0 — migrate handler sends to MessageBus (step 3)
        ├── fdef6ea — migrate watch + relay-bridge to MessageBus (step 4)
        ├── c32b9a2 — migrate cursor bridge to MessageBus (step 5)
        └── <this commit> — wrap up: infra sends, keyboards, handoff (step 6)
```

Step 2 (shadow path) was rolled into step 3; no separate commit.

## Acceptance — all met

- Outbound TG send paths consolidated:
  - `src/handlers/*` — every non-status-msg `ctx.reply` / `ctx.api.sendMessage`
    routes through the bus (via local `busReply` helpers or `getMessageBus`).
  - `src/handlers/watch.ts` streaming bubbles (tool, thinking, text,
    finalize, relay reply) — bus `send` + bus `edit`.
  - `src/cursor/index.ts` cross-post — bus `send`.
  - `src/topics/topic-manager.ts` "online" ping + history backfill — bus `send`.
  - `src/sessions/notifications.ts` broadcast — bus `send`.
- `OutboundMessage` shape: `chatId`, `threadId?`, `content`, `format?`,
  `dedupKey?`, `replyTo?`, `attachment?`, `silent?`, `replyMarkup?`,
  `opId?`. `EditInput` gains `replyMarkup?` too.
- `relay/display.ts` reduced to `createRelayDisplayState`,
  `wireRelayDisplay`, `cleanupProgressMessages`, `sendPdfReply`,
  `sendFile`. `sendTextReply` and `sendHtmlWithPlainFallback` are gone
  (deleted in step 4).
- One log schema: `bus.send opId=… chatId=… threadId=… kind=…
durationMs=… result=ok|drop:… chunkCount=…`.
- `bun run typecheck` clean.
- `bun test src/__tests__/messaging-bus.test.ts` — 30/30 pass.
  Includes the two step-6b tests: `replyMarkup` passes through as
  `reply_markup` on `send` and on `edit`.
- `bun test src/__tests__/scenarios/` — 21/22 pass. The one fail is the
  pre-existing `backfill-end-to-end` ordering flake (phase-1 handoff
  already flagged this).
- `bun run test` — all isolated test files green modulo the same flake.
- Grep verdict:

  ```
  grep -rn 'ctx\.\(reply\|api\.sendMessage\)\b' src/handlers/ --include='*.ts' \
    | grep -v "//\|TODO" | wc -l
  → 11
  ```

  Down from ~47 before step 6. The remaining 11 are documented below;
  every one carries an inline `TODO(phase-2 status-msg)` or
  `TODO(phase-2 link_preview)` rationale.

## What's NOT done — and why

These sites intentionally stay off the bus this phase. Each has an
inline `TODO` comment with a one-line explanation; the rationale is
gathered here so future maintainers don't re-investigate.

### 1. Status-message pattern (8 sites)

A "status message" is one that gets `await ctx.reply(...)`, captures the
returned grammy `Message`, then later edits or deletes it via
`ctx.api.editMessageText` / `ctx.api.deleteMessage`. The bus currently
returns either `{ messageId }` or `{ dropped, reason }` — not a
`Message`-shaped stub. Migrating these requires either:

- A bus extension that returns a richer object (a `Message`-shape stub
  with at minimum `{ message_id, chat: { id } }`), or
- A small `busStubMessage(messageId, chatId, threadId)` helper exposed
  for callers that need to edit/delete later.

The `watch.ts` streaming bubbles in step 4 took the stub-helper
approach already — see `busStubMessage` in `src/handlers/watch.ts`. The
remaining sites haven't been migrated because:

| File                      | Line(s) | Why kept                                                        |
| ------------------------- | ------- | --------------------------------------------------------------- |
| `handlers/streaming.ts`   | 388/396 | thinking/tool bubbles → `state.toolMessages` → delete on `done` |
| `handlers/streaming.ts`   | 419/430 | text segment → `state.textMessages` → edit on stream update     |
| `handlers/photo.ts`       | 259     | "Processing image" status → `api.deleteMessage` after upload    |
| `handlers/voice.ts`       | 162     | "Transcribing..." status → edit/delete on completion            |
| `handlers/document.ts`    | 260     | "Extracting..." status → `api.deleteMessage` on completion      |
| `handlers/media-group.ts` | 168     | "Receiving N items..." status → `api.deleteMessage` on flush    |

Phase 3 (or whenever the next outbound-surface tidy happens) should
either expose `busStubMessage` outside `watch.ts` and adopt it
everywhere, or grow the bus contract to return a stub natively.

### 2. `link_preview_options` (2 sites)

`src/handlers/commands.ts:2039` and `:2053` (the `/app` mini-app
launcher) pass `link_preview_options: { is_disabled: true }`. The bus
doesn't model this field. Per the step-6 plan's hard rules, we did NOT
extend the bus this step — that's a future enhancement if the surface
grows. Inline `TODO(phase-2 link_preview)` marks the sites.

### 3. Type annotation (1 site)

`src/handlers/photo.ts:235` is `let statusMsg: Awaited<ReturnType<typeof
ctx.reply>> | null = null` — a type annotation, not a call. Disappears
when site #2 (photo's status-msg pattern) is migrated.

## Remaining out-of-bus surface (intentional)

These were called out in the original plan but turned out not to need
migration:

- **`src/bridge-health.ts`** — this module is a _transformer_: it
  consumes `ctx.api.getMe()` / TG-side state and emits health events.
  It does not send messages. No work needed.
- **`src/topics/topic-manager.ts` admin APIs** —
  `api.createForumTopic`, `api.deleteForumTopic`, `api.editForumTopic`
  are forum-topic admin endpoints, not message sends. The bus models
  message sends; these admin calls stay on the raw `Api`.

## Bus contract — current state

```ts
export interface OutboundMessage {
  chatId: number;
  threadId?: number;
  content: string;
  format?: "auto" | "html" | "markdown" | "plain";
  dedupKey?: string;
  replyTo?: { messageId: number };
  attachment?: { kind: "photo" | "document" | "voice"; path: string };
  silent?: boolean;       // added step 4 for watch's quiet bubbles
  replyMarkup?: InlineKeyboardMarkup;  // added step 6b
  opId?: string;
}

export interface EditInput {
  chatId: number;
  threadId?: number;
  content: string;
  format?: FormatHint;
  replyMarkup?: InlineKeyboardMarkup;  // added step 6b
  opId?: string;
}

bus.send(msg) → Promise<{ messageId } | { dropped: "dedup"|"ratelimit"|"error", reason? }>
bus.edit(messageId, input) → Promise<{ ok: true } | { ok: false, reason }>
```

`replyMarkup` is only applied to the first chunk on chunked sends —
otherwise TG would repeat the keyboard on each chunk.

## How the test mocks evolved

A few test files needed bus-mock plumbing this step because the modules
under test newly call `getMessageBus()`:

- `src/__tests__/notifications.test.ts` — bus mock routes back through
  the test's local `sendMessage` mock so existing assertions still
  hold.
- `src/__tests__/topic-manager.test.ts` — bus mock routes through
  `mockApi.sendMessage`. Critically, the bus returns
  `{ dropped: "error", reason }` on TG failures (it does NOT throw), so
  `topic-manager`'s "stale topic" detection now inspects the
  result.reason instead of catching an exception.
- `src/__tests__/topics-integration.test.ts` — per-test `currentApi`
  registry pattern (each `makeMockApi()` call updates `currentApi`).
- `src/__tests__/plan-mode.test.ts` — added a no-op bus mock so
  busReply-routed plan-approval prompts in `callback.ts` don't blow up.
- `src/__tests__/streaming.test.ts` — bus mock routes to the per-test
  `ctx._replies` sink so existing `ctx._replies[0].options.reply_markup`
  assertions still work.
- `src/__tests__/ask-user-question.test.ts` & `commands.test.ts` —
  existing bus mocks gained `replyMarkup` → `reply_markup` translation.
- `src/__tests__/watch.test.ts` — already had a `_BusSink` mock; one
  ad-hoc `ctx.reply`-based assertion was switched to read from the sink.

These mocks all sit at the top of the test file behind `mock.module`,
matching the pattern phase-1 established.

## Pitfalls to watch

- **Returning errors vs throwing.** The bus swallows TG errors and
  reports them via the `{ dropped, reason }` shape. Any caller that
  depends on catching a thrown error (like the old `topic-manager`
  stale-topic detection) must inspect the result. `notifications.ts`
  and `topic-manager.ts` both have inline handling for this; new
  callers should follow the same pattern.
- **`replyMarkup` and chunking.** Inline keyboards are attached to the
  first chunk only. If a caller relies on a keyboard appearing on the
  last chunk (none today, but watch for it), the bus contract must
  grow.
- **Status-msg pattern adoption.** When extending the bus to return a
  Message-stub (the obvious next step), update the 8 sites listed
  above and remove the `TODO(phase-2 status-msg)` markers. Don't expose
  a half-migrated state.
- **`bus.edit` does NOT chunk.** It assumes the new content fits.
  Existing callers in `watch.ts` enforce this with explicit truncation
  before calling `edit`. If a future caller forgets, TG will return
  `MESSAGE_TOO_LONG` and the bus will surface it as `{ ok: false }`.

## Plan docs

- Overview: `docs/superpowers/plans/2026-05-25-clean-architecture-overview.md`
- Phase 2 detail: `docs/superpowers/plans/2026-05-25-phase-2-message-bus.md`
- Phase 1 handoff (predecessor): `docs/superpowers/notes/2026-05-25-phase-1-handoff.md`
