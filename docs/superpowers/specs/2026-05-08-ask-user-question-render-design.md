# AskUserQuestion Render-Only Card

## Context

Claude Code's built-in `AskUserQuestion` tool is invisible to the bridge today. The tailer parses every `tool_use` block in the JSONL session log, but `AskUserQuestion` falls through to the generic `🔧 AskUserQuestion(...)` status line — so on Telegram you see Claude is asking _something_ but not what or with which options. The user must switch to the desktop terminal to see the picker.

This design adds a render-only card: when the tailer sees an `AskUserQuestion` tool_use, it emits a dedicated event that watch.ts renders as a structured Telegram card showing the question, header, options, descriptions, and previews. **No interaction** — answering still happens at the desktop's native picker. This is the cheapest path to surfacing what Claude is asking; an interactive variant (PreToolUse hook with answer injection) is a separate, larger project.

## Architecture

Three files change, mirroring the existing `task-notification` rendering pattern (`formatTaskNotification` in `src/formatting.ts:405`).

### 1. Types — `src/types.ts:89`

Add `preview` field to the option type:

```ts
export interface AskUserQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}
```

Add a new `TailEvent` variant:

```ts
{ type: "ask_user_question"; content: ""; questions: AskUserQuestionItem[] }
```

### 2. Detect — `src/sessions/tailer.ts:417`

In the `tool_use` branch of the assistant-message dispatch, alongside the existing `mcp__channel-relay__*` special-cases, add:

```ts
if (block.name === "AskUserQuestion") {
  const input = (block.input as { questions?: AskUserQuestionItem[] }) || {};
  events.push({
    type: "ask_user_question",
    content: "",
    questions: input.questions ?? [],
  });
  continue; // skip the default `tool` event below
}
```

The `continue` is important: it suppresses the default `tool` event so we don't render both the generic status line AND our card. It also means `turn_end` logic at line 476 sees no `tool` event for this block — but since AskUserQuestion blocks the assistant turn (Claude waits for the answer before continuing), the assistant message will typically have only this single tool_use, and turn_end will fire. That matches reality: Claude _is_ done with its turn until the answer arrives.

### 3. Format — `src/formatting.ts`

New exported function:

```ts
export function formatAskUserQuestion(questions: AskUserQuestionItem[]): string;
```

Output (HTML, parse_mode HTML):

```
❓ <b>Claude is asking</b>

<i>[Header]</i>
<b>Q:</b> Which database should we use? <i>(pick any)</i>
   • <b>Postgres</b> — Full-featured, supports JSON
     <pre>schema preview...</pre>
   • <b>SQLite</b> — Simple, embedded
   • <b>MySQL</b> — Wide deployment

<i>Answer at the desktop.</i>
```

Rules:

- Header chip: rendered as `<i>[{header}]</i>` on its own line above the question if `item.header` is set; omit the line entirely if not. Brackets are literal — they distinguish the chip from a section label.
- multiSelect suffix: append `<i>(pick any)</i>` after the question text if `item.multiSelect === true`.
- Option line: `   • <b>{label}</b>` followed by ` — {description}` if description is set.
- Preview: rendered as `<pre>{preview}</pre>` on its own line under the option, if set. Truncated at **600 chars** with ellipsis (preview previews are often ASCII mockups; 600 is enough to convey shape).
- Multi-question (1–4 per call): each question rendered as a block, separated by a blank line.
- Footer: `<i>Answer at the desktop.</i>` always appended.
- Total message cap: **3800 chars** (Telegram limit is 4096 — leave headroom). If the full card exceeds the cap, truncate the _last rendered preview_ with "…" and append `<i>(card truncated — see desktop for full options)</i>`. Never truncate option labels or question text.
- All free-text fields go through `escapeHtml` before insertion.

### 4. Render — `src/handlers/watch.ts`

New `case "ask_user_question":` in the event switch (alongside `case "tool":` at line 1287). Behavior mirrors the existing `task-notification` flow:

```ts
case "ask_user_question": {
  if (state.currentToolMsg) {
    botApi.deleteMessage(chatId, state.currentToolMsg.message_id).catch(() => {});
    state.currentToolMsg = null;
  }
  if (state.currentTextMsg && !state.segmentDone) {
    finalizeTextMessage(botApi, state);
  }
  const html = formatAskUserQuestion(event.questions);
  botApi
    .sendMessage(chatId, html, { parse_mode: "HTML", ...threadOpts, ...silent })
    .then((msg) => {
      state.currentToolMsg = msg;
      trackProgress(msg);
    })
    .catch((err) => debug(`tail ask_user_question: ${err}`));
  break;
}
```

Tracked as `currentToolMsg` so the next event cycles it out via the normal delete-and-resend rhythm — same as a regular tool indicator. **No** entry in `toolUseRegistry` (we never need to correlate a tool_result for this; the answer arrives as part of the next assistant turn anyway).

## Data Flow

```
JSONL line written by Claude Code
        ↓
tailer.ts parses assistant message
        ↓
sees tool_use with name="AskUserQuestion"
        ↓
emits { type: "ask_user_question", questions: [...] }
        ↓
watch.ts handleEvent dispatches to "ask_user_question" case
        ↓
formatAskUserQuestion(questions) → HTML
        ↓
botApi.sendMessage to mapped Telegram topic
        ↓
user sees card; answers at desktop's native picker
        ↓
Claude continues; tool_result + next assistant message render normally
```

## Error Handling

- Malformed `block.input` (missing `questions`, wrong type): emit event with `questions: []`. Format function renders a minimal "Claude is asking (no options visible)" footer card. Better than crashing the tailer.
- HTML parse errors from Telegram (rare with proper escaping): catch in the `.catch(err => debug(...))`. The bridge stays alive; user just doesn't see this particular card.
- Total message > 3800 chars: handled by the truncation rule above.

## Testing

- **`tailer.test.ts`**: assistant message with `AskUserQuestion` tool_use emits exactly one `ask_user_question` event, no `tool` event, and a `turn_end` event follows.
- **`tailer.test.ts`**: assistant message with `AskUserQuestion` AND an unrelated tool_use (e.g. Read) emits both events correctly — `ask_user_question` for the AUQ block, `tool` for the Read block.
- **`formatting.test.ts`**: snapshot tests for: single Q with 2 options, single Q with header, single Q with multiSelect, option with preview (short), option with preview (>600 chars — truncates), multi-Q card, card that exceeds 3800 chars (gets card-truncation footer).
- **`formatting.test.ts`**: HTML escaping — option label containing `<script>` gets escaped.
- **`watch.test.ts`**: AskUserQuestion tool_use renders as the formatted card via `botApi.sendMessage`, NOT as the generic `🔧` status line.

## What This Does NOT Do

Explicitly out of scope:

- No inline keyboard buttons.
- No PreToolUse hook.
- No answer-injection back into the desktop session.
- No sequential question rendering (a single tool call with N questions is one card; we don't ask one-at-a-time on Telegram).
- No support for `mcp__*` MCP tools that happen to be named `ask_user_question` — only the literal built-in `AskUserQuestion` tool name.

## Unresolved Questions

- None.
