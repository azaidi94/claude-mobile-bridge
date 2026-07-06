# Origin-Topic Outbound Routing — Spec + Plan

> **Status:** Spec + implementation plan. This is the structural fix for the
> sibling-misroute _class_ (a request can land its reply in the wrong topic),
> identified by AZ: "if a request arrives on a specific topic id, why infer the
> reply destination at all?" Authored 2026-06-27 after the live misroute +
> Fix A data correction.

## 1. The insight

A Telegram message arrives **with its topic id** (`message_thread_id`). For a
request→reply, the reply destination is therefore _already known_ — it is the
originating topic. We should never infer it from session identity.

Today we DO infer it, and that inference is the entire reason the
"which-session-is-which" problem can misroute a reply. Eliminating the inference
for replies makes a wrong binding unable to misroute — it attacks the bug class
at the source, where the whole WS-1..3 consolidation only made the inference
_more correct_.

## 2. Why inference exists today (the two outbound paths)

1. **Request reply (relay path):** `sendViaRelay` (`relay-bridge.ts`) creates a
   `RelayDisplayState(chatId, threadId)` for the ORIGIN topic and a request-scoped
   `SessionTailer`; the TCP relay reply + that tailer render into the origin topic.
   This path already knows the origin — good.
2. **Observe / auto-watch (session path):** `startAutoWatch(api, chatId, threadId,
sessionName)` (`session-builder.ts`) runs a _persistent_ per-session tailer that
   streams ALL of a session's JSONL activity to the `threadId` it was bound to at
   start — derived from the topic store's session→topic mapping. This is the path
   that **infers**, and it is what misrouted: it streamed claude-62125's transcript
   to topic-3 because the (corrupt) sessionId→topic binding said so.

Both paths tail the same JSONL during a request, so a session's reply can be
rendered by BOTH — to the origin topic (path 1) AND to the bound topic (path 2).
When the binding diverges from the origin (corrupt sid, sibling swap, drift), the
two disagree and the user sees the reply in the wrong topic.

## 3. Target

- **Request replies route to the origin topic, full stop** — no session→topic
  lookup involved.
- **The session→topic binding is used ONLY for genuinely unsolicited output**
  (desktop-typed turns, autonomous work, `/clear`, tool progress with no inbound
  request) — the legitimate "observe a session in its topic" case.
- **Inbound re-anchors the binding:** when a message on topic T routes to session
  S, assert S↔T. A stale/wrong binding then self-heals the moment the user uses
  the topic — you can never send to a topic and get the reply elsewhere twice.

## 4. Design

Three changes, smallest-blast-radius first. Each is independently shippable and
testable; land + soak in order.

### D1 — Re-anchor the binding on inbound (self-healing; lowest risk)

When `sendViaRelay` resolves topic T → session S, call a new
`reassertSessionTopic(sessionName, chatId, threadId)`:

- if the topic store maps S to a different topic, update it (`updateTopicMapping`)
  and log `identity: rebound <S> <old>→<T>` (re-uses WS-1's loud-disagreement
  posture);
- if auto-watch for S is bound to a different threadId, rebind it to T.
  This alone would have prevented the reported cross on the _second_ message, and
  makes the binding converge to "wherever the user actually talks."
  Pure-testable core: `topicRebindPlan(current, sessionName, threadId) → {update?, rebind?}`.

### D2 — Outbound destination is looked up live, not captured

Make the auto-watch tailer resolve its destination via `getTopicBySession(name)`
at _dispatch_ time rather than a `threadId` captured at start. Then D1's binding
update redirects outbound immediately, with no tailer restart. Guard: if the
lookup returns undefined (topic deleted), fall back to the captured threadId.
(Contained to the auto-watch dispatch callback + event-router signature.)

### D3 — Request reply does not double-render via auto-watch

During an active `sendViaRelay` for session S, suppress the auto-watch render for
S's request-driven output (the relay path already renders it to the origin),
keying on the in-flight request. Eliminates the double-stream entirely; auto-watch
then only carries unsolicited output. (Highest-touch; do last, behind D1+D2 soak.)

## 5. Tests (TDD)

- `topicRebindPlan`: diverged binding → update+rebind; matching → no-op; no mapping → create.
- `reassertSessionTopic`: updates store + logs on divergence; idempotent when aligned.
- D2: dispatch resolves current binding; undefined → falls back to captured threadId.
- Adversarial: two siblings, user sends to topic-A then topic-B — each re-anchors
  its own session; no cross.
- Regression: the exact reported scenario (corrupt/diverged binding) — a message to
  topic T lands its reply in T.

## 6. Risk & sequencing

This is the **hottest** path in the app (live message routing). Treat like WS-3c:
each of D1/D2/D3 is its own subagent-driven task with task review + a final
whole-branch review, restart + live verification (two siblings, send to each,
confirm reply returns to the same topic), and the WS-1 invariant / `identity:`
logs watched after each. Do NOT batch D1+D2+D3 into one change. D1 is safe and
high-value on its own (self-healing); D3 is the riskiest and gated on D1+D2 soak.

## 7. Relationship to today's work

- Fix A corrected the _current_ corrupt sid swap (data); this refactor makes the
  _binding_ non-load-bearing for replies so corrupt/divergent data can't misroute
  a reply again.
- Complements the consolidation: WS-1..3 made identity inference correct; this
  removes the inference from the reply path so correctness matters less.
- This is the long-deferred "single outbound stream / honor originChat" item
  (see [[project_relay_arch]]), now with a concrete plan.
