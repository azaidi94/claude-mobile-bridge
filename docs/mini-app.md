# Mini App

[← README](../README.md)

Open the bridge in a browser or inside Telegram as a Mini App. Five tabs:

| Tab      | Purpose                                                                                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat     | Live terminal-style feed for the active session: history replay, markdown, TUI-style tool headers (Edit diffs, Bash blocks), per-tool result bodies with tap-to-expand, sticky permission-mode banner, hook cards |
| Sessions | List live + offline sessions, tap to activate                                                                                                                                                                     |
| Tasks    | Kanban board of Claude's TodoWrite items — live updates, filter per session or across all                                                                                                                         |
| Status   | CPU / memory / disk / process snapshot of the bot host                                                                                                                                                            |
| Agents   | Spawn a new desktop session into a chosen project directory                                                                                                                                                       |

## Enable

In `.env`:

```bash
WEB_ENABLED=true
WEB_PORT=4242                          # any free port
WEB_URL=http://localhost:4242          # public HTTPS URL in prod
# Optional, for opening in Telegram via deep link:
WEB_APP_SHORT_URL=https://t.me/YourBot/YourShortName
```

Build the frontend once after install and after every pull:

```bash
cd web && bun install && bun run build
```

Dev mode (hot reload):

```bash
cd web && bun run dev   # Vite at :5173, proxies API to WEB_PORT
```

The web server runs inside the main bot process — no separate command. `bun run start` (or `bun run dev` at the repo root) boots both; the bundled frontend at `web/dist/` is served from `WEB_PORT` when `WEB_ENABLED=true`.

Use `/app` from Telegram to get the Mini App link (tap-to-launch button in private chats, plain URL in groups).

## Register the Mini App with BotFather

1. `@BotFather` → `/newapp` → pick your bot → name `Terminal` (or whatever) → short name (e.g. `term`) → icon → short description → **Web App URL**: your `WEB_URL`.
2. Save the deep link (`https://t.me/YourBot/term`) and set it as `WEB_APP_SHORT_URL` in `.env`.
3. Optional menu button: `@BotFather` → `/setmenubutton` → select your bot → `Configure menu button` → paste the `WEB_URL`. Gives a one-tap launcher next to the input bar in private chats.

## Production deployment (HTTPS)

Telegram's mobile clients require HTTPS for Mini App buttons. Reverse-proxy the Hono port:

```nginx
server {
  listen 443 ssl http2;
  server_name bridge.example.com;
  ssl_certificate     /path/fullchain.pem;
  ssl_certificate_key /path/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:4242;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";      # keeps SSE alive
    proxy_buffering off;                 # SSE needs unbuffered
  }
}
```

Caddy works similarly with a one-liner. The `X-Forwarded-For` header is required for the loopback auth bypass to work safely (see [Mini App auth](#mini-app-auth) below).

## Mini App auth

Every `/api/*` request is validated against Telegram's `initData` HMAC (signed with your bot token). The Mini App sends it automatically. Three env flags control overrides:

| Flag                       | Default | Effect                                                                                                                                                                                                                                                                    |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_AUTH_BYPASS=true`     | false   | **Nuclear bypass.** All requests allowed. Only safe if `WEB_URL` is strictly localhost                                                                                                                                                                                    |
| `WEB_AUTH_LAN_BYPASS=true` | false   | Allows direct-to-port requests from loopback (`127.0.0.1` / `::1`) and RFC 1918 LAN addresses **only when** `X-Forwarded-For`/`X-Real-IP` is absent. Safe behind a reverse proxy — the proxy always sets those headers, so public traffic keeps going through normal auth |

Prefer `WEB_AUTH_LAN_BYPASS` for local and LAN access. It lets requests from the bot host or other devices on your network succeed while rejecting unauthenticated public traffic.

The bot prints a loud startup warning if `WEB_AUTH_BYPASS=true` is set with a non-localhost `WEB_URL`.
