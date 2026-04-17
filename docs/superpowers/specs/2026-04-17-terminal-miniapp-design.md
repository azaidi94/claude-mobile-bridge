# Terminal Mini App Design

**Date:** 2026-04-17  
**Status:** Approved

## Overview

Add a Telegram Mini App to claude-mobile-bridge that provides a terminal-style UI for controlling Claude Code sessions. The Grammy bot continues running unchanged alongside a new Hono HTTP server in the same Bun process. Both surfaces share session state directly in memory.

## Architecture

### Process Model

A single Bun process runs both the Grammy bot and the Hono web server. `src/index.ts` initialises the bot as today, then calls `startWebServer(state)` passing a shared state object containing the session registry, relay discovery, and watcher instances.

```
Bun process
  ├── Grammy bot (existing, unchanged)
  └── Hono server (new, port 3000)
        ├── Serves web/dist/ static files
        └── API routes (sessions, agents, system)
```

### Deployment

- Self-hosted with a domain + TLS (nginx/Caddy reverse proxy → port 3000)
- Registered as a Telegram Mini App via BotFather (`/setmenubutton`)
- Mini App opens in Telegram's built-in browser

## API Surface

| Route                            | Method    | Purpose                                            |
| -------------------------------- | --------- | -------------------------------------------------- |
| `GET /api/sessions`              | GET       | List live + recent offline sessions                |
| `GET /api/sessions/:id/stream`   | GET (SSE) | Stream tool output, text, status events            |
| `POST /api/sessions/:id/message` | POST      | Send message to session                            |
| `POST /api/agents/spawn`         | POST      | Spawn new Claude Code session `{ dir, worktree? }` |
| `GET /api/system`                | GET       | CPU / mem / disk snapshot                          |
| `GET /*`                         | GET       | Serve `web/dist/` static files                     |

All API routes require `X-Telegram-Init-Data` header validated via HMAC-SHA256 against `BOT_TOKEN`.

## Data Flow

The existing `StatusCallback` is a per-message factory. A new `SessionEventBus` (a simple in-process `EventEmitter`) sits between sessions and consumers. Both the Grammy bot's `StatusCallback` and the Mini App's SSE broadcaster emit to and subscribe from this bus, keyed by session ID.

```
Grammy bot → session.query() → StatusCallback ──┐
                                                 ↓
Mini App  → POST /message  → session.query() → SessionEventBus
                                                 ↓
                                       SSE broadcaster (per-session)
                                                 ↓
                               Hono GET /api/sessions/:id/stream
                                                 ↓
                                     Mini App ChatPage (EventSource)
```

`src/web/sse.ts` owns the `SessionEventBus` instance and exports a `subscribe(sessionId, handler)` helper used by the SSE route. The Grammy bot's streaming handler also emits to the bus so Mini App clients see live output from bot-initiated queries too.

Sending messages via the Mini App calls the same relay bridge / `session.query()` path the bot uses — no logic is duplicated.

System status polls `os` module (CPU/mem) and `df` (disk) per request — no background daemon.

Agent spawning reuses the existing session spawn logic, exposed via `POST /api/agents/spawn`.

## Frontend

A separate React + Vite + Tailwind SPA in `web/`. Built to `web/dist/`, served as static files by Hono.

### Pages

- **Chat** — scrollable terminal output (monospace, dark), streaming via `EventSource`, slash command input bar
- **Sessions** — live sessions (green dot, switch/watch) + recent offline sessions (resume spawns a new session in-process, does not open Terminal.app)
- **Status** — CPU/mem/disk gauges, Claude + bridge process listing
- **Agents** — spawn parallel Claude Code instances, follow/interrupt/kill, view completed output

### Navigation

Bottom tab bar with four items: Chat · Sessions · Status · Agents. Chat is the default landing page.

### Aesthetic

Dark background (`#0a0a0a`), monospace font for terminal output, green (`#00ff88`) accent for active states and streaming cursor. Matches the hermes-telegram-miniapp terminal style.

## File Structure

```
src/
  web/
    server.ts          ← Hono app, mounts all routes, serves static files
    auth.ts            ← initData HMAC-SHA256 validation middleware
    sse.ts             ← SSE broadcaster, one channel per session ID
    routes/
      sessions.ts      ← GET /api/sessions, POST /api/sessions/:id/message
      agents.ts        ← POST /api/agents/spawn
      system.ts        ← GET /api/system
web/
  src/
    pages/
      ChatPage.tsx
      SessionsPage.tsx
      StatusPage.tsx
      AgentsPage.tsx
    App.tsx            ← bottom tab router
    main.tsx
  vite.config.ts
  package.json
  tailwind.config.ts
```

`src/index.ts` change: one additional line calling `startWebServer({ sessions, relay, watcher })` after bot init.

## Dependencies Added

**Backend (existing package.json):**

- `hono` — HTTP server + SSE

**Frontend (web/package.json — new):**

- `react`, `react-dom`
- `@vitejs/plugin-react`, `vite`
- `tailwindcss`, `autoprefixer`
- `@telegram-apps/sdk` — Telegram Mini App SDK

## Out of Scope

- Cron/scheduling UI (future)
- Local vision/OCR (not relevant to this project)
- Replacing the Grammy bot
- Multi-user support (single-owner bot, auth via initData)
