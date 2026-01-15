# Claude Code as a Personal Assistant

Claude Code has become a capable **general-purpose agent** when given the right instructions, context, and tools. This guide shows how to set it up as a 24/7 personal assistant accessible via Telegram.

## The Setup

1. **Create a dedicated folder** (e.g., `~/personal-assistant`) with a `CLAUDE.md` that teaches Claude about you, your preferences, where your notes live, and your workflows.
2. _OPTIONAL_: **[Symlink](https://en.wikipedia.org/wiki/Symbolic_link) configuration files** into this folder. For example, symlink `~/.claude/commands` and `~/.claude/skills` so you can easily add new capabilities.
3. _OPTIONAL_: **Track the folder as a Git repository** for version control.
4. **Set this folder as the working directory** for the bot (via `CLAUDE_WORKING_DIR`).

**To keep CLAUDE.md lean**, reference your notes system rather than embedding everything directly.

The main "Notes" folder referenced in `CLAUDE.md` can be an iCloud folder that syncs to [Ulysses](https://ulysses.app/) or [iA Writer](https://ia.net/writer), so you can see changes made by your assistant live on all devices.

Extend capabilities by installing [MCPs](https://code.claude.com/docs/en/mcp), adding [commands](https://code.claude.com/docs/en/slash-commands), and [skills](https://code.claude.com/docs/en/skills). Skills are particularly powerful — they're auto-triggered based on context and define specific workflows for common tasks.

**The magical part: when you need a new capability, just ask Claude to build it.** Even via the Telegram bot, on the go.

## CLAUDE.md is the Assistant's Brain

The `CLAUDE.md` file in your personal assistant folder is the centerpiece of the setup.

Since Claude runs with prompt permissions bypassed (see [SECURITY.md](../SECURITY.md)), it can browse folders, read/write files, and execute commands within allowed paths.

Here's a template:

````
# CLAUDE.md

This file provides guidance to Claude Code so it can act as [Your Name]'s personal assistant.

## Quick Reference

**This folder:**
- `cli/` - Utility scripts (run with `bun run cli/...`)
- `.claude/skills/` - Task workflows (things-todo, gmail, research, workout-planning, etc.)
- `.claude/agents/` - Subagents for pulse and digests

**Key paths:**
- Notes: `~/Documents/Notes/` (Me/, Research/, Health/, Journal/)
- Personal docs: `~/Documents/Personal/`

## About [Your Name]

[Your Name] is a [age]yo [profession] based in [City].

[Brief context about work, lifestyle, hobbies, etc.]

For personal context, goals, and finances — see the Me/ files below.

**Keeping context fresh**: When new personal information emerges, proactively update the relevant Me/ notes.

## How to Assist

- **Choose the right source(s)**: Autonomously decide where to look. Search multiple sources in parallel when needed
- **Always check the date**: For time-sensitive questions, run `date` first
- **Communication style**: [e.g., "Balanced and friendly, use emojis sparingly"]
- **Autonomy**: Handle routine tasks independently, ask before significant actions
- **Formatting**: Prefer bullet lists over markdown tables
- **Priority**: Highlight important items; don't just dump lists

**CRITICAL**: When asked to remember something, update the relevant file:
- Personal goal → `life-goals.md`
- Personal context → `personal-context.md`
- Claude behavior → `CLAUDE.md`

# KNOWLEDGE & FILES

Notes are stored in `~/Documents/Notes/` (synced to iCloud). Use search tools for finding content.

## Personal Context (Me/)

Source-of-truth files:
- `personal-context.md` — Family, friends, preferences, habits
- `life-goals.md` — Long-term objectives
- `pulse.md` — Current life digest
- `finances.md` — Financial overview

## Other Folders

- `Journal/` — Monthly entries by year
- `Health/` — Diet, workouts, training plan
- `Research/` — Research notes

# TASK MANAGEMENT

## Tasks

Use task management skills for task creation, scheduling, and project routing.

**When asked "what's on my plate"**: Check both tasks AND calendar.

## Calendar

Use calendar CLI or MCP for checking schedule.

## Email

Use email skill for email workflows.

````

The _"keeping context fresh"_ instruction creates a **file-based memory system**, since Claude automatically reads and updates context files as it learns new things about you.

## Example: Claude as a Personal Trainer

One powerful use case is having Claude act as a personal trainer that knows your diet, training plan, and recent activity.

The setup:

1. **[Health Auto Export](https://www.healthyapps.dev/)** - An iOS app that syncs Apple Health data to iCloud as daily JSON files
2. **A CLI script** (`cli/utils/health.ts`) that reads those files and returns structured health data
3. **A `workout-planning` skill** that defines the workflow for creating workouts based on training plan and recent activity
4. **A Notes folder** (synced via iCloud) where workout logs are saved as markdown

A health script can return data like:

```json
{
  "current": {
    "sleep": { "duration": "8h 6m", "deep": "2h 4m", "rem": "2h 4m" },
    "activity": { "steps": 6599, "distance": "5.1km", "activeCalories": 582 },
    "vitals": { "restingHR": 48, "hrv": 70.6 }
  },
  "trends": {
    "last7days": { "avgSleep": "7h 40m", "avgRestingHR": 56.6, "avgHRV": 68.8 }
  },
  "recovery": { "score": 80, "status": "optimal" }
}
```

A **`workout-planning` skill** example:

```markdown
---
name: workout-planning
description: Create personalized workout plans based on training program and recent activity.
allowed-tools: Read, Write, Bash(cli/utils/health.ts workouts:*), Glob
---

# Workout Planning

When asked for a workout:

1. **Read training program**: `~/Documents/Notes/Health/training.md`
2. **Check recent logs**: `~/Documents/Notes/Health/Workouts/`
3. **Check workout frequency**: Run health CLI to see last 7 days
4. **Propose appropriate workout** based on schedule and recent activity
5. **Create** the workout file: `Health/Workouts/YYYY-MM-DD-workout.md`
```

When you message "give me a workout", Claude:

1. Checks your training plan
2. Looks at recent workouts
3. Considers recovery score
4. Creates a workout log file

Since your Notes folder syncs via iCloud, open [Ulysses](https://ulysses.app/) on your phone at the gym and the workout is right there. You can message Claude mid-workout asking to tweak something, and the file updates live.

## Example: Life Pulse Command with Subagents

[Commands](https://code.claude.com/docs/en/slash-commands) let you define reusable prompts with dynamic context.

[Subagents](https://code.claude.com/docs/en/sub-agents) are specialized agents that Claude can delegate tasks to. Each runs with its own context window, keeping the main conversation lean.

### Why Subagents?

A complex command like `/life-pulse` needs to gather data from many sources: email, work issues, health metrics, web news. If the main agent does all this directly, the context window fills up fast.

Example subagents for a life pulse:

| Subagent | Job | Returns |
| --- | --- | --- |
| `gmail-digest` | Analyze inbox | Unread needing attention, orders |
| `linear-digest` | Analyze work issues | In-progress, blockers |
| `health-digest` | Analyze health data | Brief health check-in |
| `for-you-digest` | Curate web content | Interesting items |

### Subagent Example

```
---
name: health-digest
description: Analyzes health metrics and provides a brief check-in.
tools: Bash, Read
model: haiku
---

You are a health-conscious friend giving a quick check-in.

## Data Gathering

Run the health script to get metrics.

## Analysis

Look for what's actually notable:
- Sleep significantly better/worse than usual
- Resting HR trending up (stress) or down (fitness)
- HRV changes over the past month

## Output

Return a brief check-in (3-5 lines). Write like a friend, not a medical report.
```

### The Main Pulse Command

A simplified `/life-pulse` command:

````
---
description: Generate executive life digest
allowed-tools: Bash, Read, Write, Task
---

# Generate Life Pulse

## Implementation

1. **Gather Data** (run in parallel):
- Tasks and calendar (lightweight, main agent handles)
- **Email**: Invoke `gmail-digest` subagent
- **Health**: Invoke `health-digest` subagent
- **For You**: Invoke `for-you-digest` subagent

2. **Synthesize** the outputs into sections:
- **TL;DR**: Bullet points capturing essential state
- **Now**: What needs attention (3-6 items max)
- **For You**: Curated content with links
- **Health**: From health-digest

3. **Write** to `~/Documents/Notes/life-pulse.md`
````

All raw data stays contained in fast subagent runs. The main agent only sees synthesized summaries.

## Example: Dynamic Calendars

Claude can **manage calendars that sync to your phone**:

```
YAML config → sync.py → .ics file → GitHub Gist → Google/Apple Calendar
```

[GitHub Gist](https://gist.github.com/) URLs are stable, so calendar apps that subscribe to them auto-refresh when content changes.

Claude can build scrapers for event info scattered across websites. The output is structured YAML:

```yaml
gist:
  id: your-gist-id
  filename: events.ics
calendar:
  name: "My Events"
  timezone: Europe/Lisbon
events:
  - date: "2026-01-11"
    time: "09:00"
    title: "Event Name"
    duration_minutes: 540
    description: "Event details..."
    url: https://example.com/event
```

A `sync.py` script converts YAML to iCalendar format and pushes to GitHub. Subscribe to the Gist URL once in Google/Apple Calendar, and updates sync automatically.

## Example: Claude as a Researcher

Claude can do thorough research by searching multiple sources and synthesizing findings.

A **`research` skill** handles the workflow:

```markdown
---
name: research
description: Research topics thoroughly using web search, Reddit, and Hacker News.
allowed-tools: WebSearch, WebFetch, Bash, Read, Write
---

# Research Workflow

**CRITICAL: Every research task MUST save results to `~/Documents/Notes/Research/`.**

## Process

1. **Check existing research** first
2. **Search thoroughly** using multiple sources:
   - WebSearch for general information
   - Reddit for community insights
   - Hacker News for tech discussions
3. **Synthesize** findings with clear recommendation
4. **Save to file** - update if exists
```

When you message something like "research upgrade options for X", Claude:

1. Checks existing research
2. Searches web, Reddit, Hacker News
3. Synthesizes everything
4. Saves a comprehensive research document

## Example: Claude as a Co-Worker

With **Slack, Linear, and Notion** integrations, Claude can keep track of what's happening at work.

Ask things like:
- "What are my teammates up to? Any blockers?"
- "Catch me up on the #progress-updates channel"
- "What's the latest on the API v2 project?"

### Setting Up Slack Access

1. **Create a Slack app** at [api.slack.com/apps](https://api.slack.com/apps)
2. **Add OAuth scopes** under "OAuth & Permissions":
   - `channels:history` - Read messages in public channels
   - `channels:read` - List channels
3. **Install the app** to your workspace and copy the Bot User OAuth Token
4. **Invite the bot** to channels you want it to read

The bot can only see messages in channels it's been invited to.

### The CLI

A simple Slack CLI:

```bash
bun run cli/integrations/slack.ts channels              # List joined channels
bun run cli/integrations/slack.ts messages general      # Recent from #general
bun run cli/integrations/slack.ts recent                # Recent across all channels
bun run cli/integrations/slack.ts thread <url>          # Full thread from URL
```

Combined with Linear and Notion access, Claude can give you a complete picture of what's happening at work — all from a quick Telegram message.

---

It's up to you whether to create scripts, skills, commands, or any combination to empower your agent. Sky's the limit.
