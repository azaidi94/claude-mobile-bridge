# Tool Results & Session-State Events — Parity with Claude Code TUI

Status: design (approved through brainstorm; ready for review)

## Problem

Three categories of JSONL events that Claude Code's TUI surfaces, but our web UI and Telegram drop entirely:

1. **`tool_result`** — every tool's response. Bash output, Grep matches, Agent "Done (N tools · Xk tokens · Ys)", Read line count, Edit confirmation, error/success colour. **315 events in a recent session, all dropped.** Currently skipped at `src/sessions/tailer.ts:243` (`if (content.every(b => b.type === "tool_result")) return null`) and `src/web/sessions/history.ts:39` (`tool_result intentionally skipped`).
2. **`permission-mode`** — Plan / Auto-accept / Bypass mode toggles. Claude renders as a banner; from the chat alone you can't tell what mode the agent is in. **78 events in current session.**
3. **`system` → subtype `stop_hook_summary`** — when stop hooks fail (lint blocked the commit, etc.). Claude surfaces these prominently. **79 system events, many of this subtype.**

Together these are the largest remaining content gap between Claude Code's TUI and our two surfaces (web UI and Telegram).

## Goal

Telegram and web UI render the same three event categories as Claude Code, in idiomatic per-surface form. Tool results correlate visually to their tool call (re-render the same `ToolBlock` in web; selective edit-in-place in Telegram). Session-state events render as standalone banners (web) or compact lines (Telegram). No regression to existing Telegram or web behaviour.

## Non-goals

- Streaming long Bash output mid-execution. Tool_result events are atomic in the JSONL — written when the tool completes — so we don't need to render partial output during a 30-second `bun test`. (Future enhancement; not blocking.)
- Surfacing all dropped event types. The audit identified ~9 event categories beyond these three (queue-operation, attachment, image content blocks, mcp_instructions_delta, deferred_tools_delta, edited_text_file, hook_success non-stop, etc.). User confirmed they're not blocking; deferred.
- Server-side stitching of tool_use + tool_result. The tailer is filesystem-tail-based and emits events as they appear; correlation happens client-side via a `Map<toolUseId, ToolResult>`. Same pattern as Claude Code's TUI (`ToolUseLoader` re-renders with new props when `inProgressToolUseIDs` changes).

## References

- **TUI architecture note**: [`docs/superpowers/notes/2026-04-23-claude-code-tui-rendering.md`](../notes/2026-04-23-claude-code-tui-rendering.md) — three-layer rendering model, same-component-re-render pattern for tool transitions, overlay taxonomy.
- **Prior spec**: [`2026-04-23-unified-chat-truth-design.md`](./2026-04-23-unified-chat-truth-design.md) — establishes `originChat` dedup contract and the SSE bridge architecture this spec extends.

## Data model

Three new `TailEventType` members + three additions to `TailEvent`:

```ts
// src/sessions/tailer.ts
export type TailEventType =
  | "user"
  | "text"
  | "tool"
  | "thinking"
  | "turn_boundary"
  | "relay_reply"
  | "tool_result" // NEW
  | "permission_mode" // NEW
  | "hook_summary"; // NEW

export interface TailEvent {
  type: TailEventType;
  content: string;
  originChat?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  // NEW — populated only for type "tool_result":
  toolUseId?: string; // pairs with the corresponding tool_use block
  isError?: boolean; // result indicates failure
  resultMeta?: {
    // per-tool parsed metrics; populated where useful
    bashLineCount?: number;
    grepMatchCount?: number;
    globFileCount?: number;
    readLineCount?: number;
    agentToolUses?: number;
    agentTokens?: number;
    agentDurationMs?: number;
  };
  // NEW — populated only for type "permission_mode":
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  // NEW — populated only for type "hook_summary":
  hook?: {
    hookCount: number;
    errorCount: number;
    preventedContinuation: boolean;
    firstError?: string;
    failingHookName?: string;
  };
}
```

`originChat` does **not** apply to `permission_mode` or `hook_summary` (they're session-level, not channel-routed). For `tool_result`, `originChat` carries through if and only if the originating `tool_use` was channel-routed (rare — only `mcp__channel-relay__*` results) — but the tailer doesn't need to special-case this since the tool_result block doesn't carry the wrapper. Practically: `tool_result.originChat` is always `undefined`. Surfaces use the _tool_use_'s originChat (already known via the in-flight Map keyed by toolUseId) for any dedup decisions.

## Tailer changes (`src/sessions/tailer.ts`)

### `parseLine` — top-level entries

Add three new branches to the existing dispatch:

```ts
// Inside parseLine, after the existing assistant/user branches:

if (entry.type === "permission-mode") {
  const mode = entry.permissionMode;
  if (typeof mode !== "string") return [];
  // Dedup against the last emitted mode happens at consumer level —
  // tailer is stateless w.r.t. cross-line context.
  return [
    {
      type: "permission_mode",
      content: mode,
      permissionMode: mode as TailEvent["permissionMode"],
    },
  ];
}

if (entry.type === "system" && entry.subtype === "stop_hook_summary") {
  const hookCount = Number(entry.hookCount) || 0;
  const errorCount = Array.isArray(entry.hookErrors)
    ? entry.hookErrors.length
    : 0;
  const preventedContinuation = Boolean(entry.preventedContinuation);
  // Suppress the noise case: hook ran cleanly, no errors, no prevention.
  if (errorCount === 0 && !preventedContinuation) return [];
  const firstError =
    errorCount > 0
      ? String(entry.hookErrors[0]?.error ?? entry.hookErrors[0] ?? "")
      : undefined;
  const failingHookName =
    errorCount > 0 ? String(entry.hookErrors[0]?.name ?? "") : undefined;
  return [
    {
      type: "hook_summary",
      content: firstError ?? `${hookCount} hook(s) ran`,
      hook: {
        hookCount,
        errorCount,
        preventedContinuation,
        firstError,
        failingHookName,
      },
    },
  ];
}
```

### `parseLine` — `tool_result` content blocks

Today the user-message branch returns `null` if every content block is `tool_result`. New behaviour: when content blocks include `tool_result`, emit one `tool_result` TailEvent per block.

```ts
// Inside the user-message branch (currently filtering tool_result-only):
if (Array.isArray(content)) {
  const events: TailEvent[] = [];
  for (const block of content) {
    if (block.type === "tool_result") {
      const toolUseId = String(block.tool_use_id ?? "");
      if (!toolUseId) continue;
      const isError = Boolean(block.is_error);
      const text = extractToolResultText(block.content);
      events.push({
        type: "tool_result",
        content: text,
        toolUseId,
        isError,
        // resultMeta populated lazily by the rendering layer — tailer just
        // ships the raw text; per-tool parsers (bash line count, grep match
        // count, etc.) live in the renderer where the tool name is known.
      });
    }
  }
  if (events.length > 0) return events;
  // ... fall through to existing user-text handling for non-tool_result content
}
```

`extractToolResultText` flattens `block.content` (which can be string or array of `{type:"text", text}` blocks) into a single string.

### Dedup of `permission-mode`

The tailer is stateless across lines. Dedup happens at consumer level:

- **Web SSE bridge** keeps a per-session `lastPermissionMode` and skips emit when unchanged.
- **Telegram watch handler** does the same — skips `case "permission_mode"` when `state.lastPermissionMode === event.permissionMode`.

This keeps the tailer simple and lets late-joining web clients still receive the _current_ mode on connect (via history replay).

## SSE event extension (`src/web/sse.ts`)

Extend `SseEvent`:

```ts
export interface SseEvent {
  type:
    | "text"
    | "tool"
    | "thinking"
    | "segment_end"
    | "done"
    | "send_file"
    | "tool_result"
    | "permission_mode"
    | "hook_summary"; // NEW
  content: string;
  segmentId?: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  // NEW:
  toolUseId?: string;
  isError?: boolean;
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  hook?: {
    hookCount: number;
    errorCount: number;
    preventedContinuation: boolean;
    firstError?: string;
    failingHookName?: string;
  };
}
```

## SSE bridge (`bridgeTailToSse` in `src/handlers/watch.ts`)

Extend the existing switch:

```ts
case "tool_result":
  bus.emit(sessionId, {
    type: "tool_result",
    content: event.content,
    toolUseId: event.toolUseId,
    isError: event.isError,
  });
  return;
case "permission_mode":
  bus.emit(sessionId, {
    type: "permission_mode",
    content: event.permissionMode ?? "",
    permissionMode: event.permissionMode,
  });
  return;
case "hook_summary":
  bus.emit(sessionId, {
    type: "hook_summary",
    content: event.content,
    hook: event.hook,
  });
  return;
```

`originChat === "web"` filter applies to `tool_result` only (mirrors current convention). `permission_mode` and `hook_summary` are session-level — no origin filtering.

## Web history replay (`src/web/sessions/history.ts`)

Lift the `tool_result intentionally skipped` filter at `mapUserEntry`. Mirror the tailer logic:

```ts
function mapUserEntry(entry: JsonlEntry): SseEvent[] {
  // ... existing channel-tag handling ...
  if (Array.isArray(content)) {
    const events: SseEvent[] = [];
    for (const block of content) {
      if (block.type === "text") {
        /* existing */
      } else if (block.type === "tool_result") {
        events.push({
          type: "tool_result",
          content: extractToolResultText(block.content),
          toolUseId: String(block.tool_use_id ?? ""),
          isError: Boolean(block.is_error),
        });
      }
    }
    return events;
  }
  // ...
}
```

Also: `mapAssistantEntry` and the wrapping `readSessionHistory` need to handle two new top-level types (`permission-mode`, `system`) — treat them the same way the tailer does.

## Web UI rendering

### `ToolBlock` augmentation (`web/src/components/Terminal.tsx`)

Add a `result?: { content: string; isError: boolean; meta?: ResultMeta }` prop to `ToolBlock`. When present:

- Bullet recolours: `text-green-400` (success) / `text-red-400` (error). Today it's static `text-terminal-muted`.
- Body adds a `ToolResultBody` sub-component beneath the existing per-tool body (Edit diff, Bash command, etc.).

### Per-tool result body shape (the promotion list)

Implemented as a small dispatch in `ToolResultBody` keyed on `toolName`:

| Tool                                                                 | On success                                                                                                                                   | On error                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Bash**                                                             | Last 5 lines of stdout in a `<pre>`; if more, "+N lines (click to expand)". Footer: "exit 0 · 2.3s" if available.                            | Full stderr in red `<pre>` (capped at ~200 lines). |
| **Grep**                                                             | "Found N matches in M files" (parsed from result text).                                                                                      | First 200 chars of error.                          |
| **Glob**                                                             | "Found N files".                                                                                                                             | Same as Grep.                                      |
| **Agent / Task**                                                     | Parse "tool_uses · tokens · elapsed" from result and render "Done (7 tools · 36.4k tokens · 36s)". Below: optional click-to-show full reply. | Show error message.                                |
| **WebFetch**                                                         | "Fetched N chars from <url>".                                                                                                                | Error.                                             |
| **WebSearch**                                                        | "N results" + first 3 titles.                                                                                                                | Error.                                             |
| **Read, Write, Edit, MultiEdit, MCP, Skill, ToolSearch, all others** | _Render nothing_ (success body suppressed). Bullet still recolours green so user knows it succeeded.                                         | Error message rendered (red bullet + body).        |

Result text is parsed lazily — small per-tool helpers (~5-10 lines each) inside `ToolResultBody`. No changes to the SSE event shape.

### `PermissionModeBanner`

A new tiny component, rendered as a sticky banner at the top of `Terminal`'s scroll viewport:

- `default` → no banner (the implicit norm).
- `plan` → yellow banner: "📋 Plan mode — agent will not modify files".
- `acceptEdits` → green banner: "✅ Auto-accept edits".
- `bypassPermissions` → grey banner: "⚙ Bypass permissions" (informational only — this is a power-user mode).

Banner state derived from latest `permission_mode` SseEvent. Updates only on change (consumer-level dedup).

### `HookSummaryCard`

A new inline component in the assistant turn body, rendered when `hook_summary` event arrives. Red border, hook name, first error truncated to ~200 chars, click-to-expand for full hookErrors array if needed.

## Telegram rendering (`src/handlers/watch.ts`)

### `case "tool_result"` (new)

```ts
case "tool_result": {
  // Look up the tool name from in-state cache populated when the
  // matching tool_use fired. The cache lives on WatchState — see below.
  const toolName = state.toolUseRegistry?.get(event.toolUseId ?? "");

  // Rule Z: promote on error always; promote on success only for
  // tools whose result content is informative.
  const PROMOTE_ON_SUCCESS = new Set([
    "Bash", "Grep", "Glob", "Task", "Agent", "WebFetch", "WebSearch",
  ]);
  const shouldPromote =
    event.isError === true || PROMOTE_ON_SUCCESS.has(toolName ?? "");

  if (!shouldPromote) {
    // Ephemeral path: tool message stays as-is; result is dropped.
    // Free the registry entry to avoid unbounded growth.
    state.toolUseRegistry?.delete(event.toolUseId ?? "");
    break;
  }

  // Promote: delete the previous tool message (currentToolMsg may still be
  // pointing at it from case "tool"); send a combined "✓/✗ Tool · summary".
  if (state.currentToolMsg) {
    botApi.deleteMessage(chatId, state.currentToolMsg.message_id).catch(() => {});
    state.currentToolMsg = null;
  }
  const summary = formatToolResultSummary(toolName, event.content, event.isError);
  botApi
    .sendMessage(chatId, summary, { parse_mode: "HTML", ...threadOpts })
    .catch((err) => debug(`tail tool_result: ${err}`));

  state.toolUseRegistry?.delete(event.toolUseId ?? "");
  break;
}
```

The `WatchState.toolUseRegistry: Map<toolUseId, toolName>` is populated in the existing `case "tool"` (when an event has `toolName` and `toolUseId` — both already on `TailEvent`). Bounded growth: each entry is deleted on its result.

`formatToolResultSummary` (new function in `src/formatting.ts`):

- Bash success: `▶️ Bash · <last line of output>` (one line, truncate 80) + "+N lines" if multi-line.
- Bash error: `❌ Bash failed: <first 80 chars of error>`.
- Grep: `🔎 Found N matches`.
- Agent: `🎯 Agent done · 7 tools · 36.4k tokens · 36s`.
- Generic error: `❌ <toolName> error: <first 80 chars>`.

### `case "permission_mode"` (new)

```ts
case "permission_mode": {
  if (state.lastPermissionMode === event.permissionMode) break; // dedup
  state.lastPermissionMode = event.permissionMode;
  const label = {
    default: "default",
    plan: "Plan mode on",
    acceptEdits: "Auto-accept on",
    bypassPermissions: "Bypass permissions on",
  }[event.permissionMode!] ?? event.permissionMode;
  botApi.sendMessage(chatId, `⚙ ${label}`, threadOpts).catch(() => {});
  break;
}
```

### `case "hook_summary"` (new)

```ts
case "hook_summary": {
  const h = event.hook!;
  const verb = h.preventedContinuation ? "blocked the run" : "failed";
  const tag = h.failingHookName ? ` <code>${escapeHtml(h.failingHookName)}</code>` : "";
  const trail = h.firstError ? `: ${escapeHtml(h.firstError.slice(0, 200))}` : "";
  botApi.sendMessage(
    chatId,
    `🪝 stop hook${tag} ${verb}${trail}`,
    { parse_mode: "HTML", ...threadOpts },
  ).catch(() => {});
  break;
}
```

## Test matrix

New tests:

1. **Tailer**: `tool_result` content block emits `{type:"tool_result", toolUseId, content, isError}`.
2. **Tailer**: `tool_result` with `is_error:true` carries `isError:true`.
3. **Tailer**: `permission-mode` entry emits `{type:"permission_mode", permissionMode}`.
4. **Tailer**: `system` with `subtype:"stop_hook_summary"` and `errorCount:0` returns `[]` (suppressed when clean).
5. **Tailer**: `system` with `subtype:"stop_hook_summary"` and `hookErrors:[…]` emits `{type:"hook_summary", hook:{...}}`.
6. **Tailer**: `system` with non-stop_hook subtype returns `[]` (other system subtypes still ignored).
7. **Web history replay**: `tool_result` content block surfaces in `readSessionHistory`.
8. **SSE bridge**: `tool_result`, `permission_mode`, `hook_summary` all forward to `globalEventBus`.
9. **Web ToolBlock**: when `result` prop is set, bullet colour changes (success → green, error → red).
10. **Web ToolBlock**: per-tool result body renders for Bash (last-5 + "+N lines"), Grep (count), Agent (metrics).
11. **Web Terminal**: `permission_mode === "plan"` shows the yellow banner; subsequent identical event doesn't re-render.
12. **Telegram watch**: `case "tool_result"` for Bash promotes (sends combined message), for Read does not (ephemeral kept).
13. **Telegram watch**: `case "permission_mode"` dedups consecutive identical modes.
14. **Telegram watch**: `case "hook_summary"` sends one message per hook failure.

## Files touched

- `src/sessions/tailer.ts` — three new event types in parseLine + `extractToolResultText` helper.
- `src/handlers/watch.ts` — three new switch cases in `handleTailEvent`; extend `bridgeTailToSse`; add `WatchState.toolUseRegistry` and `lastPermissionMode`.
- `src/formatting.ts` — `formatToolResultSummary` per-tool helper.
- `src/web/sse.ts` — extend `SseEvent` shape.
- `src/web/sessions/history.ts` — handle `tool_result` blocks; handle top-level `permission-mode` + `system`/`stop_hook_summary` entries.
- `web/src/api.ts` — extend client-side `SseEvent` type.
- `web/src/components/Terminal.tsx` — `ToolBlock` accepts `result` prop; new `PermissionModeBanner`, `HookSummaryCard`; client-side `Map<toolUseId, ToolResult>` correlation.
- New tests across `src/__tests__/tailer.test.ts`, `src/__tests__/watch.test.ts`, `src/__tests__/sse-bridge.test.ts`, `src/__tests__/web-sessions-history.test.ts`, `web/src/__tests__/Terminal.test.tsx`.

## Risks & mitigations

- **Memory growth in `toolUseRegistry`** if tool_result events go missing (e.g. session killed mid-run). Mitigation: cap registry size to last N entries (e.g. 100); evict oldest. Or expire entries older than 5 minutes. Add a test for the cap.
- **Race: tool_result arrives in SSE before tool_use** (theoretically possible with the watch tailer if reads are batched). Mitigation: web client tolerates orphan results — `Map.set(toolUseId, result)` on receipt, `ToolBlock` looks up at render. If tool_use shows up later, the result is already there.
- **`permission-mode` dedup state lives on WatchState (Telegram) and a per-session ref (web)** — both are per-session so client/server stay aligned. Initial state on web reload comes from history replay; the in-memory ref is initialised from the most recent permission_mode event in that replay.
- **Telegram message volume**: even with selective promote, busy sessions could post N Bash results. The existing `currentToolMsg` delete-on-text rule (case "text" deletes the in-flight tool message before streaming text) would also wipe promoted tool_result messages. Decision: promoted tool_result messages must NOT be tracked as `currentToolMsg` — they're assigned a separate `state.lastResultMsg = msg` (or simply not tracked) so subsequent text/relay_reply doesn't sweep them up. Same for `resetDisplaySegment` cleanup of `progressMessages` — `trackProgress(msg)` is NOT called for result messages.
- **Backward compatibility**: every change is additive on the wire. Old web clients see new event types as `unknown` and ignore them gracefully (existing render paths already handle unknown event types).

## Rollout

Single PR, no feature flag. Changes are additive for both surfaces (new event types, new render paths; nothing existing is removed except the two `tool_result intentionally skipped` filters). Revert is a clean `git revert`.

## Open items for user review

- **Promotion list**: confirm the seven tools in `PROMOTE_ON_SUCCESS` (Bash/Grep/Glob/Task/Agent/WebFetch/WebSearch). Anything to add or remove?
- **`permission_mode === "default"`**: render an explicit banner ("Default mode") or no banner (the implicit norm)? Recommend no banner — only the non-default modes are signal.
- **Other `system` subtypes**: the audit found `subtype:"turn_duration"` (turn took 2.3s) entries; Claude Code doesn't surface them. Recommend ignore (continue treating non-stop_hook system events as no-op). Confirm.
