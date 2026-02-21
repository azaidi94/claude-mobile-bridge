# Killer Features Brainstorm

What would make Claude Mobile Bridge go from "useful Telegram wrapper" to "I can't code without this on my phone."

---

## Tier 1 — The Big Ones

### 1. Proactive Watchers & Alerts

Right now the bot is reactive: you send a message, Claude responds. Flip that.

- **CI/CD watcher**: Monitor GitHub Actions / CI pipelines. When a build fails, Claude proactively messages you with what broke, which test failed, and a suggested fix. One tap to say "fix it."
- **PR watcher**: Get notified when PRs are opened, reviewed, or merged. Claude summarizes the diff and flags concerns.
- **File change watcher**: Watch specific files or directories. "Notify me if anyone touches `src/auth/`."
- **Error log watcher**: Tail a log file or error monitoring service. When something spikes, Claude analyzes it and pings you.

**Why it's killer**: You're away from your desk but still in the loop. You catch production issues in minutes, not hours.

### ~~2. Background Tasks & Queued Workflows~~ ✅ IMPLEMENTED

~~Send Claude a batch of work and walk away.~~

Implemented as `/queue` command. Parses numbered/bulleted task lists, processes sequentially with live progress updates, per-task notifications, final summary, and `/stop` cancellation. See `src/queue.ts` and `src/handlers/commands.ts`.

### ~~3. Live Desktop ↔ Mobile Handoff~~ ✅ IMPLEMENTED

~~The session auto-discovery already exists. Take it further.~~

Implemented as `/watch` and `/unwatch` commands. Streams desktop session activity (tool calls, text responses) to your phone in real-time via session JSONL tailing. See `src/handlers/watch.ts` and `src/sessions/tailer.ts`.

### 4. GitHub-Native Workflow

Deep git integration accessible from your phone:

- `/pr` — Create a PR from current changes with auto-generated title/description
- `/review <url>` — Claude reviews a PR and posts comments directly to GitHub
- `/diff` — See the current working tree diff formatted for Telegram
- `/commit` — Auto-generate a commit message and commit
- `/merge <pr>` — Merge a PR after Claude validates checks pass
- `/issues` — List open issues, pick one, Claude starts working on it

**Why it's killer**: Full git workflow from your phone. Review PRs while waiting for coffee.

---

## Tier 2 — Major Differentiators

### 5. Conversation Branching

```
/branch "try-redis-approach"
```

Fork the current conversation. Try an approach. If it doesn't work:

```
/branches          # List all branches
/switch main       # Go back to the fork point
```

Compare outcomes side by side. Pick the winner.

**Why it's killer**: Eliminates "should I try this?" anxiety. Try both approaches, compare, decide.

### 6. Smart Notifications with Context

When a long-running task finishes, don't just say "done." Send:

```
✅ Task complete: Fix auth middleware

📝 Changes:
  • Modified src/middleware/auth.ts (+12 -3)
  • Added src/__tests__/auth.test.ts (+45)

🧪 Tests: 42 passed, 0 failed
💰 Cost: $0.18 (2.1k in / 890 out)
⏱️ Duration: 2m 34s

[View Diff] [Create PR] [Undo All]
```

Action buttons right on the notification.

**Why it's killer**: You get the full story at a glance. No need to ask follow-up questions.

### 7. Voice Response (TTS)

Claude doesn't just accept voice — it responds with voice.

- Toggle with `/voice on` — all responses come as voice notes
- Or use inline: "think about this and voice your response"
- Respects language — responds in the language you spoke

**Why it's killer**: True hands-free coding. Listen to Claude's explanation while driving, walking, cooking. Accessibility win too.

### 8. Session Templates & Workspaces

```
/template create frontend
  --dir ~/code/frontend
  --model sonnet
  --prompt "You are working on a React/Next.js app..."
  --mcp github,linear

/template use frontend   # Instant context-loaded session
```

Pre-configured environments for different projects and modes of work.

**Why it's killer**: Zero warm-up time. Jump straight into productive work on any project.

### 9. Cost Tracking & Budget Controls

```
/cost            # Today: $3.42 | This week: $18.90 | This month: $67.13
/cost session    # This session: $0.84 (12 messages)
/budget $100/mo  # Alert at 80%, pause at 100%
```

Per-session, per-day, per-project cost breakdown. Budget alerts via Telegram.

**Why it's killer**: API costs are real. Knowing your spend and having guardrails prevents surprises.

### 10. Interactive File Browser

Navigate your codebase visually:

```
/browse src/
```

Returns an inline keyboard tree:

```
📁 src/
  📁 handlers/     →
  📁 sessions/     →
  📄 bot.ts        [View] [Edit]
  📄 config.ts     [View] [Edit]
  📄 index.ts      [View] [Edit]
```

Click to drill down, preview files, or tell Claude to edit them.

**Why it's killer**: Spatial navigation of code from your phone. Way faster than describing which file you mean.

---

## Tier 3 — Delightful Extras

### 11. Webhook Receiver

Accept incoming webhooks and have Claude react:

```
/webhook create github --events push,pull_request
# Returns: https://your-bot.example.com/hook/abc123
```

When a webhook fires, Claude analyzes the event and takes action or notifies you based on rules you set.

### 12. Offline Message Queue

Phone has signal but your server is down? Messages queue up. When sessions come back online, they're processed in order. You get notified of each result as it completes.

### 13. Screenshot → Fix Pipeline

Take a screenshot of a bug on your phone → send to Claude → Claude identifies the component, finds the code, proposes a fix → one tap to apply.

This already partially works with photo support, but making it a first-class workflow with "fix this" as the default action would be powerful.

### 14. Scheduled Tasks

```
/schedule "9am daily" run tests and summarize results
/schedule "every 6h" check error logs and alert if anything new
/schedule "friday 5pm" generate weekly changelog from commits
```

Cron-style task scheduling. Results delivered as Telegram messages.

### 15. Multi-User Collaboration

Multiple authorized users see the same session. User A asks Claude to fix a bug, User B sees the progress and can chime in. Threaded conversations per user to avoid confusion.

### 16. Snippet Library

```
/save auth-pattern    # Saves current conversation context
/snippets             # List saved snippets
/load auth-pattern    # Injects saved context into current session
```

Reusable knowledge that persists across sessions. Like bookmarks for your coding conversations.

### 17. Diff Preview Before Apply

Before Claude writes any file, show the diff inline:

```diff
 // auth.ts
-const token = req.headers.authorization;
+const token = req.headers.authorization?.replace('Bearer ', '');
```

```
[Apply] [Skip] [Edit] [Apply All]
```

File-by-file approval with real diffs, not just plan descriptions.

---

## Implementation Priority

If I had to pick 3 to build first:

1. **Smart Notifications** (#6) — Low effort, high impact. Already have streaming infrastructure.
2. **GitHub Workflow** (#4) — `gh` CLI is already available. Wrap it in commands.
3. **Background Task Queue** (#2) — Builds on existing session management. Biggest workflow unlock.

These three together transform the bot from "chat with Claude on your phone" to "manage your entire dev workflow from anywhere."
