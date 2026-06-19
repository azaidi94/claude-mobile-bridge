# 2026-05-31 — Ductor-adoptions overnight handoff

Branch: `feat/ductor-adoptions` (off `feat/auto-watch-consistency`). Not
pushed; no PR opened. Five features landed as separate commits, each with
tests + typecheck clean. The bot has **not been restarted** — your running
PID is still pre-this-work. Restart to pick everything up.

## What landed

1. **`c3dbeea`** stage-aware emoji reactions on inbound TG messages.
   - 👀 received → 🤔 working → 🎉 done, tracked per-thread in
     `src/handlers/reactions.ts`. Wired into `text.ts` (received) and
     `watch/event-router.ts` (working + done). Tests in
     `__tests__/reactions.test.ts`. No config needed.

2. **`36cc43d`** `/interrupt` as gentler sibling of `/stop`.
   - `/interrupt` cancels the running SDK query but **keeps** pending
     interactive state (plan approval, AUQ, settings input).
   - `/stop` now does the same cancel **and clears** those pendings —
     "fresh slate" semantics.
   - Both share `abortQuery` in `commands/control.ts`. The TG command
     menu lists both.

3. **`cf6b93f`** Webhook wake mode: `POST /api/webhook/notify`.
   - Body: `{session?, topicId?, text, source?}`. Auth: bearer secret
     from `WEBHOOK_SECRET` env. Empty secret disables the route.
   - **You need to set `WEBHOOK_SECRET=<something>` in `.env`** for it
     to do anything. `.env.example` updated.
   - Routes via `getTopicBySession` if you pass a session name;
     `topicId` is the raw thread_id (works for General too).

4. **`ff43e97`** Cron: `/cron list|add|del|on|off` + minute-aligned
   scheduler.
   - Store at `~/.claude-mobile-bridge/cron.json`. Specs are 5-field
     UTC cron expressions (no shortcuts like `@daily`).
   - A fired job: posts a labelled header `⏰ cron <spec>` to the
     session's topic AND relays the prompt into the running session
     via `getRelayClient`. If the session is offline at fire time, the
     header notes it and the prompt is **not queued for later**.
   - Scheduler only starts when `primaryChatId` is known.

5. **`03ed467`** Saved prompts as tappable inline keyboards: `/prompts
list|add|del`.
   - Store at `~/.claude-mobile-bridge/prompts.json`.
   - `/prompts add <label> | <text>` saves global. `/prompts add!` saves
     scoped to the current session's topic (📌 indicator in the menu).
   - Tap → injects the prompt's text into the session via `sendViaRelay`
     (same path as a typed message).

## Deferred / honest gaps

- **/interrupt without a queue:** ductor's mental model assumes a real
  message queue; we don't have one. I mapped the distinction to "keep vs
  clear pending interactive state," which is meaningful but not exactly
  what ductor does. If you ever add a queue, /stop is the place to drain
  it.
- **Cron does not resurrect offline sessions.** If you want jobs to spin
  up a CC session at fire time, that's a follow-up.
- **Reactions only wire through the watch/tail event path.** Pure
  cursor-bridge replies and direct SDK runs (no watch active) won't
  promote 👀 → 🤔 → 🎉. Reasonable next step but I didn't want to touch
  three more pipelines overnight.
- **Old junk `cursor-vscode-file://...` topics in TG**: the TG forum
  topics were deleted earlier today. The bot's store still has dead
  entries; `/cleanzombie` from TG will tidy them.

## To activate

```bash
# Optionally add a webhook secret:
echo "WEBHOOK_SECRET=$(openssl rand -hex 16)" >> .env

# Restart bot
launchctl kickstart -k gui/$(id -u)/com.azaidi.claude-bot
```

## Test status

Each commit passes its own tests + typecheck. The pre-existing
`web-tasks-watcher.test.ts` is timing-flaky (2s timeout) and occasionally
red on a busy machine; that's unrelated to anything here.
