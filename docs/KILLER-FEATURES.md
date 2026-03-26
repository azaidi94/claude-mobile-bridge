# Killer Features

What would make Claude Mobile Bridge go from "useful Telegram wrapper" to "I can't code without this on my phone."

---

## Implemented

- **Background task queue** — `/queue` with progress, per-task notifications, `/skip`, `/stop`
- **Live desktop handoff** — `/watch` streams desktop session to phone, type to take over
- **Plan mode** — `/plan` for propose-then-execute workflow with approval buttons
- **File navigation** — `/pwd`, `/cd`, `/ls` for browsing the filesystem
- **Screenshot analysis** — Send a photo, Claude identifies the issue and fixes it
- **Interactive buttons** — Claude presents options as tappable inline keyboards

---

## Tier 1 — High Impact, Feasible Now

### 1. Smart Task Summaries

When a task or queue item finishes, show a rich summary instead of just the response:

```
✅ Fix auth middleware (2m 34s)

📝 src/middleware/auth.ts (+12 -3)
   src/__tests__/auth.test.ts (+45 new)
🧪 Tests: 42 passed
💰 $0.18 (2.1k in / 890 out)

[View Diff] [Create PR] [Undo All]
```

**Why**: At a glance you know what changed, whether tests pass, and can act immediately. No follow-up questions needed.

**Hooks into**: `session.lastUsage` already tracks tokens. Run `git diff --stat` after task completion. Action buttons use existing callback infrastructure.

### 2. Cost Tracking

```
/cost            # Today: $3.42 | This week: $18.90 | This month: $67.13
/cost session    # This session: $0.84 (12 messages)
```

Per-session, per-day, per-project cost breakdown.

**Why**: API costs are real. Visibility prevents surprises.

**Hooks into**: `lastUsage` already captures per-query tokens. Need a persistent store (append-only JSONL) and aggregation logic.

### 3. Voice Response (TTS)

Claude responds with voice notes, not just text.

- `/voice on` — toggle voice responses
- Respects language of input
- Falls back to text for code-heavy responses

**Why**: True hands-free coding. Listen while walking/driving. Big accessibility win.

**Hooks into**: OpenAI TTS API (client already initialized for STT). Pipe response text through `openai.audio.speech.create()`, send as voice note.

### 4. CI/CD Watcher

Monitor GitHub Actions. When a build fails, Claude messages you with what broke and a suggested fix.

```
🔴 CI failed on main (push by @ali)

Failed: test-unit (Node 20)
  ✗ auth.test.ts > should validate JWT expiry
    Expected: 401, Received: 200

[Fix It] [View Logs] [Ignore]
```

**Why**: Catch failures in minutes, not hours. One tap to fix.

**Hooks into**: `gh run list --json` polling on an interval. Notification infrastructure already exists (`createNotificationHandler`). Could start as a simple `/ci watch` command.

---

## Tier 2 — Worth Building

### 5. Scheduled Tasks

```
/schedule "9am daily" run tests and summarize results
/schedule "friday 5pm" generate weekly changelog from commits
```

**Why**: Automate recurring work. Morning test reports, EOD summaries.

**Hooks into**: Bun timers or node-cron. Queue infrastructure already handles sequential task execution.

### 6. Conversation Branching

```
/branch "try-redis-approach"    # Fork current conversation
/branches                       # List branches
/switch main                    # Go back
```

**Why**: Try an approach risk-free. Compare outcomes, pick the winner.

**Hooks into**: Agent SDK's `resume` with session IDs. Store a map of branch name → session ID. `/switch` already exists for sessions, extend it.

### 7. Inline File Browser

Upgrade `/ls` with tappable inline keyboards:

```
📁 src/handlers/
  📂 sessions/      [Open]
  📄 bot.ts         [View] [Edit]
  📄 config.ts      [View] [Edit]
```

Click to drill down, preview files, or tell Claude to edit them.

**Why**: Spatial navigation beats describing file paths. Much faster on mobile.

**Hooks into**: `/ls` already reads directories. Add callback buttons using existing `InlineKeyboard` patterns.

---

## Tier 3 — Nice to Have

### 8. Webhook Receiver

Accept GitHub/external webhooks, have Claude analyze and act on events. Requires running an HTTP server alongside the bot.

### 9. Offline Message Queue

Messages persist to disk when no session is available. Processed in order when a session comes online.

### 10. Multi-User Collaboration

Multiple users see the same session, threaded per-user. High effort — rethinks the session ownership model.

---

## Dropped from Original List

These were in the original brainstorm but are no longer worth dedicated effort:

- **GitHub commands** (`/pr`, `/diff`, `/commit`) — Claude already has `gh` CLI access through tools. Just ask it. Custom commands add minimal UX over that.
- **Session templates** — `/new [name] [path]` + `/model` already covers most of this. System prompt is in config.
- **Snippet library** — Claude has its own memory and context management. Solving a problem that doesn't really exist.
- **Diff preview before apply** — Plan mode already serves this purpose. Per-file approval would require intercepting tool calls mid-execution, which the SDK doesn't support cleanly.

---

## Recommended Build Order

1. **Smart task summaries** — Low effort, high visibility. Git diff + cost already trackable.
2. **Cost tracking** — Low effort. Persistent token log + `/cost` command.
3. **Voice response** — Low effort. OpenAI TTS client already available.
4. **CI watcher** — Medium effort. Biggest "wow" feature for mobile-first workflow.
