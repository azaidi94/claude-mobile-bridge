# /usage Command — Design

## Goal

Add `/usage` Telegram command that mirrors the user's statusline session-usage display, showing 5-hour and 7-day Claude Code quota utilization with reset times.

## Background

User runs a statusline (`~/.claude/scripts/claude-usage.sh`) that hits `https://api.anthropic.com/api/oauth/usage` with the OAuth token from macOS keychain and renders e.g. `S:33.0% (1h 49m) | W:23.0% (5d 8h)`. They want the same data on demand from the Telegram bot, with a slightly richer multi-line layout.

## Scope

**In:**

- New `/usage` command, authorized + rate-limited like other commands
- Reads OAuth token from macOS keychain (`security find-generic-password -s "Claude Code-credentials" -w`)
- Fetches `https://api.anthropic.com/api/oauth/usage` directly via `fetch`
- Renders HTML `<pre>` block with progress bars + reset times
- Unit tests: unauthorized, happy path (mocked fetch + keychain), API error path

**Out:**

- Caching (manual command, fresh each call)
- Non-macOS token retrieval
- Threshold notifications / scheduled pushes

## Architecture

New file `src/handlers/usage.ts` exporting `handleUsage(ctx)`. Wired into `bot.ts` via `bot.command("usage", handleUsage)`, re-exported from `src/handlers/index.ts`, and listed in `/help`.

### Token retrieval

```ts
async function readKeychainToken(): Promise<string | null> {
  const proc = Bun.spawn(
    [
      "security",
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-w",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
  if (proc.exitCode !== 0) return null;
  const raw = (await new Response(proc.stdout).text()).trim();
  try {
    return JSON.parse(raw).accessToken ?? null;
  } catch {
    return null;
  }
}
```

### Fetch

```ts
const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
  headers: {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
  },
});
```

Expected response shape:

```ts
{
  five_hour: {
    utilization: number;
    resets_at: string; /* ISO */
  }
  seven_day: {
    utilization: number;
    resets_at: string; /* ISO */
  }
}
```

### Format helper

```ts
function formatResetIn(isoTs: string): string {
  const secs = Math.max(0, Math.floor((Date.parse(isoTs) - Date.now()) / 1000));
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
```

### Bar

10-segment bar from `█`/`░`, where filled = `round(utilization / 10)` clamped to `[0,10]`.

### Output

```
📊 Usage

Session (5h)  ████████░░  33%
└ resets in 1h 49m

Weekly (7d)   ██░░░░░░░░  23%
└ resets in 5d 8h
```

Wrapped in `<pre>…</pre>` so the bar/columns render in monospace on Telegram.

### Errors

- No token (keychain miss / parse fail): `❌ Could not read Claude credentials from keychain.`
- HTTP non-200: `❌ Usage API returned <status>.`
- JSON shape unexpected: `❌ Could not parse usage response.`

All caught and replied; no throws bubble up.

## Testing

`src/__tests__/commands.test.ts` adds `describe("commands: /usage", …)`:

1. Unauthorized user → "Unauthorized" reply.
2. Happy path: stub `Bun.spawn` to return a fake credentials JSON, stub `globalThis.fetch` to return the expected shape → reply contains `Session`, `Weekly`, both percents, both reset strings.
3. Fetch returns 401 → reply contains `401`.

`spyOn(globalThis, "fetch")` for fetch mocking. Token retrieval lives in an exported `readKeychainToken` helper in `src/handlers/usage.ts` so tests can `spyOn(usage, "readKeychainToken")` instead of intercepting `Bun.spawn`.

## Files Touched

- `src/handlers/usage.ts` (new)
- `src/handlers/index.ts` (export)
- `src/bot.ts` (register command)
- `src/handlers/commands.ts` (add `/usage` to `handleHelp` text)
- `src/__tests__/commands.test.ts` (tests)

## Open Questions

(none)
