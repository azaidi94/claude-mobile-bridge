# Phase 4 — Relay sessionId via env var

**Goal:** Replace the relay's 200-line racing JSONL-discovery heuristic with a simple env-var contract: the parent CC tells the relay its sessionId at spawn time.

**Estimated effort:** 1 day.

**Branch:** `refactor/phase-4-relay-env`

**Dependencies:** Phases 1–3 are not required, but Phase 0's tests should be green.

## Why

`src/mcp/channel-relay/server.ts` lines 60–280 are a heuristics maze:

- `getParentStartedAtMs()` — `ps -o lstart=` probe of the parent claude
- `discoverSessionId()` — scans `~/.claude/projects/<dir>/*.jsonl`, filters by birthtime > parent-start − 30s, mtime > relay-start, not-already-claimed by another relay
- `runDiscovery()` — polls every 3s, 5s, 10s, 20s, 30s, then 60s, with retry-on-port-file-rewrite-race (we patched this twice this week)
- `claimedSessionIds()` — coordinates between concurrent relays for the same dir
- `updateOwnPortFile()` — merge sessionId in

All of this exists because **the relay doesn't know its parent's sessionId**. But Claude Code _does_ know it — it's in `process.env.CLAUDE_SESSION_ID` for the parent, and could trivially be forwarded to MCP children.

If CC sets `CLAUDE_SESSION_ID` in the env of MCP children (which it already does in many places), the relay reads it at startup, writes it to the port file, done. No polling, no birthtime guessing, no claimed-set coordination.

## What we don't know yet

Does CC currently forward a session-id env var to MCP servers? Need to verify by:

1. Reading recent CC source (we have it via context) for what env vars are set when spawning MCP children
2. Running the relay with `console.log(process.env)` and grepping for likely names: `CLAUDE_SESSION_ID`, `CLAUDE_CODE_SESSION`, `CLAUDE_PROJECT_SESSION`, etc.

If CC already forwards it: pure win, minimal work.

If CC doesn't forward it: we have two fallbacks:

- (a) Read it from CC's stdin via the MCP initialization message — MCP `initialize` passes `clientInfo` and could carry session metadata if CC adds it.
- (b) Have CC's _plugin loader_ (not the MCP child) write a sidecar file next to the JSONL with the sessionId, and the relay reads that. More invasive but no protocol dep.

## Target

```ts
// src/mcp/channel-relay/server.ts (refactored)

const cwd = process.cwd();
const dirHash = ...;
const PORT_FILE = ...;

// New: prefer env var; keep discovery as fallback for old CC versions.
const envSessionId = process.env.CLAUDE_SESSION_ID;
const parentSessionId = envSessionId ?? getParentClaudeSessionId();

writePortFile({ port, pid, ppid, sessionId: parentSessionId, cwd, ... });

if (!parentSessionId) {
  // No env, no --session-id flag — fall back to the heuristic.
  // 5-line fallback that may set sessionId later via updateOwnPortFile.
  startSessionIdDiscoveryLoop();
} else {
  // No discovery needed — we know.
  process.stderr.write(`channel-relay: sessionId=${parentSessionId} from env\n`);
}
```

The 200-line discovery code becomes optional, only relevant for old CC versions that haven't been updated to set the env var.

## Scope

### Files that change

| File                                                       | Change                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/mcp/channel-relay/server.ts`                          | Add env-var check at startup. Keep discovery as fallback but flag it as legacy. |
| `src/relay/backfill.ts`                                    | (Already from today's work) keeps doing its job for relays running old code.    |
| `src/__tests__/cursor-cdp.test.ts` and channel-relay tests | Add cases for env-var path + fallback.                                          |
| Docs                                                       | Note the env-var contract in `docs/superpowers/specs/relay-protocol.md` (new).  |

### Anthropic-side (not in our control)

We can't change CC itself. But if `CLAUDE_SESSION_ID` is already in CC's env when launching MCP servers (likely true post-2026), we win for free. If not, we file an upstream issue and ship the fallback as the temporary main path.

## Stepwise approach

1. **Investigate (~1 hr).** Run a relay with `env > /tmp/relay-env.txt` and inspect what CC actually sets. Document findings.
2. **Implement env-first path (~2 hr).** If the env var exists, write it to the port file and skip the loop entirely.
3. **Keep fallback (~1 hr).** Don't delete the discovery loop — versions of CC older than the env-var era still need it. Annotate as legacy.
4. **Tests (~2 hr).** Cover both paths with explicit fixtures (env set vs unset).
5. **Smoke test (~1 hr).** Restart all 4 of our active relays and confirm port files get sessionId immediately (no 3s wait, no retries).

## Acceptance criteria

- When `CLAUDE_SESSION_ID` is set in the relay's env, the port file has `sessionId` populated within ms of startup (verify via `cat ~/.claude-mobile-bridge/channel-relay-*.json` immediately after `ccd`)
- When `CLAUDE_SESSION_ID` is unset, the discovery loop still runs and produces the same result as today
- New test: relay started with `CLAUDE_SESSION_ID=xxx` produces a port file with `sessionId=xxx` regardless of JSONL state
- No regression in any existing relay test

## Risks

- **CC doesn't set the env var.** Then this phase doesn't help much directly — but the fallback path is already what we have, and we can still propose it upstream.
- **CC sets a different var name.** Easy fix: read both. Document precedence.
- **Resumed sessions.** A resumed CC session might pass the old sessionId. Need to verify that's what we want (probably yes — the port file should track the _current_ sessionId, which is the resumed one).

## Out of scope

- The backfill module (already shipped today)
- Changing the relay's TCP wire protocol
- Changing how the bot looks up port files
