# Claude Code TUI Rendering Architecture

Reference note distilled from exploring `~/Projects/Cursor/Other/claude_code_source` on 2026-04-23. Written to inform the upcoming **tool-result wiring** spec for our web UI / Telegram parity work.

## Three-layer architecture

```
┌──────────────────────────────────────────┐
│ FROZEN SCROLLBACK (above the fold)       │  ← OffscreenFreeze caches React refs
│  Old user turns                          │     once they scroll offscreen.
│  Old assistant turns + tool blocks       │     React reconciler bails on
│  Older still…                            │     identical refs → zero re-render.
├──────────────────────────────────────────┤
│ LIVE VIEWPORT (below the fold)           │  ← Composed of multiple components,
│  Streaming assistant text (per-token)    │     each re-rendering on its own
│  In-flight tool spinners                 │     cadence. NOT a single monolith.
│  Bash progress / output tail             │
│  Agent progress line                     │
│  Input prompt                            │
├──────────────────────────────────────────┤
│ OVERLAYS — three flavours                │  ← Mode depends on overlay type.
│  Alt-screen takeover (DEC 1049)          │     Slash modals share screen with
│  Inline overlay (in scrollbox)           │     transcript via "transcript peek"
│  Bottom modal pane (with ▔ divider)      │     of last 2 rows.
└──────────────────────────────────────────┘
```

## Layer 1 — Frozen scrollback

- **Mechanism:** `src/components/OffscreenFreeze.tsx` — a wrapper that caches the React element reference once the message has scrolled out of the visible viewport (measured via `useTerminalViewport()`). Subsequent renders return the cached ref; React's reconciler short-circuits, the subtree is skipped entirely.
- **Why not Ink's `<Static>`:** the source explicitly notes "Ink doesn't support multiple `<Static>` components" (`src/utils/staticRender.tsx`). They needed multiple frozen regions.
- **Scope:** every message that scrolled offscreen — user turns, assistant turns, completed tool blocks, completed tool results.
- **Consequence:** scrollback is essentially zero-cost to leave alone. Streaming a long Bash output doesn't re-render unrelated history.

## Layer 2 — Live viewport

Several independent components re-render on their own clocks; they're not children of a single coordinator:

| Component                              | Re-render trigger      | What it shows                                                                   |
| -------------------------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| `AssistantTextMessage` (streaming)     | Every token            | Partial text, parsed through `<Markdown>` each frame                            |
| `AssistantThinkingMessage` (streaming) | Every token            | Indented thinking content; collapsed in compact mode                            |
| `ToolUseLoader`                        | Tool state transitions | The `●` bullet — dim while running, green on success, red on error              |
| `ShellProgressMessage`                 | Output chunk + 1s tick | Last 5 lines of bash output (clipped via `Box overflow="hidden"`); elapsed time |
| `BashModeProgress`                     | Bash state transitions | Spinner / running indicator                                                     |
| `AgentProgressLine`                    | Agent status           | "Running Agent: search-tool…"                                                   |

Once any of these "completes" (the model's text turn ends; the tool returns; the bash exits), the message gets a final shape and — once it scrolls offscreen — gets frozen by `OffscreenFreeze`.

## Layer 3 — Overlays

### Alternate-screen takeover (DEC 1049)

`src/ink/components/AlternateScreen.tsx` — issues `\x1b[?1049h` on mount, `\x1b[?1049l` on unmount. Saves the main buffer; restores it perfectly on exit (terminal-native feature).

- **Used for:** the `ctrl+o` transcript expansion, vim-like full-screen pagers.
- **Web equivalent:** a full-route `<Modal>` with `position: fixed; inset: 0; z-index: 50` that takes over the viewport; close → return to chat with no scroll loss.

### Inline overlay (within the scrollable area)

`overlay` slot in `FullscreenLayout.tsx` — sits between the scrollback and the input prompt, scrolls _with_ the messages above. The user can scroll up to read context while the prompt stays in view.

- **Used for:** permission prompts ("Allow this Bash command?"), plan-approval dialogs.
- **Web equivalent:** a sticky banner inside the chat container, not at the page level. Scrolls with the conversation.

### Bottom modal pane

`modal` slot in `FullscreenLayout.tsx` — absolute-positioned, anchored to the bottom of the scroll area. A `▔` divider separates it from the messages above. Height capped by `ModalContext.rows` to (terminal rows − transcript-peek − divider).

- **Used for:** every slash command UI (`/help`, `/init`, `/cost`, `/settings`, `/plugins`).
- **Transcript peek:** `MODAL_TRANSCRIPT_PEEK = 2` — the modal deliberately leaves 2 rows of conversation visible above the divider so the user remembers where they are.
- **Web equivalent:** `position: fixed; bottom: 0` panel; `max-height: calc(100vh - 80px)` to leave a chat sliver visible.

## Tool message lifecycle — the key "in-place" insight

Tools do NOT edit a line in place. The illusion is created by **the same React component instance re-rendering with different props**:

```
Time T+0   queued    ToolUseLoader props={isUnresolved: true,  isError: false}  → ● dim
Time T+1   running   ToolUseLoader props={isUnresolved: true,  isError: false}  → ● dim, blinking
Time T+2   done      ToolUseLoader props={isUnresolved: false, isError: false}  → ● green
Time T+2   error     ToolUseLoader props={isUnresolved: false, isError: true}   → ● red
```

The component is mounted once per tool call; its `props.tool` and `props.toolUseResult` change. React reconciles: same DOM node, new color. No line replacement, no terminal scroll-back rewrite.

Tool **results** append below the tool call as a sibling element (`BashToolResultMessage`, `FileEditToolUpdatedMessage`, etc.) when they arrive. The result's container can collapse / expand, but the result content itself isn't re-edited.

## Editing past input

When the user up-arrows and resubmits:

- The old user message **stays in scrollback** (frozen).
- A new user message **appends** below.
- The previous assistant turn **stays** between them (not scrubbed).
- The new assistant turn appends after the new user message.

History is purely additive. There is no "rewrite the past turn" path.

## Streaming text commit

```
1. Token arrives          → assistant message component (live, not frozen) re-renders with growing text
2. More tokens arrive     → re-render again, MarkdownComponent re-parses the partial text
3. Stream completes       → message marked complete in state; rendering stabilises
4. Message scrolls off    → OffscreenFreeze caches the ref → frozen for the rest of the session
```

The `<Markdown>` re-parse on every token is acknowledged as expensive but accepted as the cost of live preview.

## Tool grouping

`src/utils/groupToolUses.ts` — applies `applyGrouping()` during message _normalization_ (not at render time). Consecutive `tool_use` blocks **with the same `tool_name` within a single assistant turn** coalesce into a `GroupedToolUseMessage`. The tool's `renderGroupedToolUse` handler (if defined) takes over rendering for the bundle.

## Width and resize

- Terminal width comes from `TerminalSizeContext`. Layout re-computes when it changes.
- Hard wrapping happens at _render time_ — already-rendered scrollback in the terminal doesn't reflow on resize. Users must scroll up to see history as-was; the new render uses the new width.
- Web doesn't have this problem; CSS reflows automatically.

## Implications for our web UI

| TUI pattern                                         | Web mapping                                                        | Notes                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `OffscreenFreeze` (free off-viewport freeze)        | Virtual list + `React.memo`                                        | DOM doesn't have ref-equality short-circuiting at the renderer level. Use `@tanstack/virtual` or similar; memo each row.    |
| Live region below scrollback                        | Sticky footer outside the virtual list                             | Spinners and streaming text live in a separate container so they don't trigger row re-renders.                              |
| Same-component re-render for tool state transitions | Same React pattern works unchanged                                 | Our `ToolBlock` should accept `result` prop and conditionally colour the bullet — no separate "result" message.             |
| Streaming text via re-render then commit            | Same pattern works unchanged                                       | A `streaming: true` flag on the partial assistant message; re-renders on each SSE event; "commits" when SSE `done` arrives. |
| Alt-screen takeover                                 | `position: fixed; inset: 0` modal                                  | Trivial.                                                                                                                    |
| Inline overlay (permission prompts)                 | Sticky banner inside chat container                                | Less common in our app; not currently planned.                                                                              |
| Bottom modal pane (slash commands)                  | `position: fixed; bottom: 0` with `max-height: calc(100vh - 80px)` | Mirrors the "transcript peek" idea. We don't have slash-command modals yet, but the pattern is here when needed.            |
| Tool grouping (consecutive same-name)               | Same logic, applied at SSE-event-stream level before turn assembly | Future polish; not blocking.                                                                                                |

## Direct relevance to tool-result wiring

The single most important pattern to copy is **same-component-re-render for tool state transitions**. Our existing `ToolBlock` should:

1. Accept an optional `result` prop containing `{content, isError, durationMs?}`.
2. When `result` is present, set the bullet colour (`text-green-400` / `text-red-400` instead of muted).
3. Render the per-tool result body **as part of the same component tree** (not a sibling event). For Agent: parse "tool_uses · tokens · elapsed" from the result text. For Bash: render last ~5 lines + "+N lines" affordance. For Grep: render match count.

The client-side correlation is straightforward: maintain a `Map<toolUseId, ToolResult>` populated as `tool_result` SSE events arrive; pass the matching result down as a prop when rendering each tool block.

## See also

- Spec / plan for unified chat truth: `docs/superpowers/specs/2026-04-23-unified-chat-truth-design.md`, `docs/superpowers/plans/2026-04-23-unified-chat-truth.md`.
- Source explored: `~/Projects/Cursor/Other/claude_code_source/src/{components,ink,utils}`.
