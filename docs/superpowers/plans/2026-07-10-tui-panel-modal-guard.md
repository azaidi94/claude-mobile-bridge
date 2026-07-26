# Interactive `/tui` Panel, Send Guard, and Modal Watchdog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user drive a blocked Claude Code TUI from Telegram, and stop `sendKeysToSession` from silently confirming a modal dialog.

**Architecture:** A new `src/tmux/` module holds one IO seam (`exec.ts`) and two pure cores (`modal-detect.ts`, `keys.ts`). `/peek` attaches an inline key panel; `sendKeysToSession` gains a capture→send→verify→Enter guard; a watchdog polls for blocked sessions and pushes an alert carrying the same panel.

**Tech Stack:** Bun 1.3.11, TypeScript, grammy (Telegram), `bun:test`, tmux on the `-L claude` socket.

**Spec:** `docs/superpowers/specs/2026-07-10-interactive-tui-panel-design.md`

**Branch:** `feat/tui-panel-modal-guard` (already exists, spec already committed)

## Global Constraints

- Commit messages: **no** "Generated with Claude Code" footer, **no** `Co-Authored-By` trailer.
- A pre-commit hook runs `prettier --write`, `bunx tsc --noEmit`, and the full test suite. A commit fails if typecheck or any test fails. Expect prettier to reformat your files during commit.
- Run a single test file with `bun test src/__tests__/<file>.test.ts`. Run everything with `bun run test`. Typecheck with `bun run typecheck`.
- Tests live flat in `src/__tests__/*.test.ts`. `scripts/test-isolated.sh` runs each file in its own process.
- The governing safety rule: **when pane state is unknown (empty capture), never send Enter.**
- Fixture panes MUST be captured from a live Claude Code under tmux. Never hand-author one. A hand-authored fixture encodes our belief about how a dialog renders; the tests would pass and the guard would still fail on the real dialog.
- Telegram callback data has a hard 64-byte limit.
- Settle after `send-keys` before re-capture is **500 ms**. Do not lower it.

## File Structure

| File                                                | Responsibility                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/tmux/exec.ts` (create)                         | The only place that shells out to tmux. `runTmux`, `isNoServer`, `capturePane`, `tmuxBase`, `TmuxTarget`. |
| `src/tmux/modal-detect.ts` (create)                 | Pure. Gate A (footer token), Gate B (bar sandwich), delivery verification.                                |
| `src/tmux/keys.ts` (create)                         | Pure. Action→argv map, keyboard builder, callback parser.                                                 |
| `src/tmux/watchdog.ts` (create)                     | Pure planner `planModalAlerts` + thin timer `startModalWatchdog`.                                         |
| `src/handlers/commands/tmux.ts` (modify)            | `/peek` attaches the panel; new `tui:*` callback branch; `replyBlockedPanel` renderer.                    |
| `src/handlers/commands/terminal-inject.ts` (modify) | `sendKeysToSession` gains the guard; `InjectResult` gains `blocked`/`pane`/`launchUuid`.                  |
| `src/handlers/commands/inject.ts` (modify)          | `/clear`, `/compact`, `/context` render the blocked panel.                                                |
| `src/handlers/callback.ts` (modify)                 | Route `tui:` callbacks.                                                                                   |
| `src/index.ts` (modify)                             | Start the watchdog.                                                                                       |
| `scripts/tmux/capture-fixtures.sh` (create)         | Capture a live pane into a fixture file.                                                                  |
| `src/__tests__/fixtures/tmux-panes/*.txt` (create)  | Captured panes.                                                                                           |

---

### Task 1: Extract the tmux IO seam into `src/tmux/exec.ts`

Behaviour-preserving. Reconciles the two ways the codebase names the tmux server: `tmux.ts` hardcodes `-L claude`, `terminal-inject.ts` passes `-S <socket path>` from the port file. Both address the same server. The guard needs both files to capture the same pane, so this must be unified before anything else.

**Files:**

- Create: `src/tmux/exec.ts`
- Modify: `src/handlers/commands/tmux.ts` (delete local `runTmux`, `isNoServer`; import them; re-export `isNoServer`)
- Test: `src/__tests__/tmux-exec.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `interface TmuxTarget { pane: string; socket?: string }`
  - `function tmuxBase(target?: { socket?: string }): string[]`
  - `function runTmux(argv: string[]): { ok: boolean; stdout: string; stderr: string }`
  - `function isNoServer(stderr: string): boolean`
  - `function capturePane(target: TmuxTarget): string` — returns `""` on ANY failure

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/tmux-exec.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { tmuxBase, isNoServer, capturePane } from "../tmux/exec";

describe("tmuxBase", () => {
  test("defaults to the -L claude socket name", () => {
    expect(tmuxBase()).toEqual(["tmux", "-L", "claude"]);
    expect(tmuxBase({})).toEqual(["tmux", "-L", "claude"]);
  });

  test("uses -S with an explicit socket path", () => {
    expect(tmuxBase({ socket: "/tmp/tmux-501/claude" })).toEqual([
      "tmux",
      "-S",
      "/tmp/tmux-501/claude",
    ]);
  });
});

describe("isNoServer", () => {
  test("true for a genuinely absent server", () => {
    expect(isNoServer("no server running on /tmp/tmux-501/claude")).toBe(true);
    expect(isNoServer("error connecting to /tmp/x (No such file)")).toBe(true);
  });

  test("false for a missing tmux binary — that is a real failure", () => {
    expect(
      isNoServer("tmux not runnable: ENOENT no such file or directory"),
    ).toBe(false);
  });
});

describe("capturePane", () => {
  test("returns empty string when the pane does not exist", () => {
    // %999999 cannot exist; tmux exits non-zero (or there is no server at all).
    // Either way the contract is the same: "" means UNKNOWN, never proceed.
    expect(capturePane({ pane: "%999999" })).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/tmux-exec.test.ts`
Expected: FAIL — `Cannot find module '../tmux/exec'`

- [ ] **Step 3: Write the implementation**

Create `src/tmux/exec.ts`:

```ts
/**
 * The single place this codebase shells out to tmux.
 *
 * Two call sites historically named the same server differently: the /tmux panel
 * hardcoded `-L claude` (a socket NAME), while terminal-inject passed `-S <path>`
 * (a socket PATH) read from the relay port file. Both reach the same server. The
 * send guard requires that a capture and a send-keys target the same pane, so the
 * naming is decided here, once.
 */

/** A tmux target: the pane id, and the socket PATH if the port file recorded one. */
export interface TmuxTarget {
  pane: string;
  socket?: string;
}

/** The launcher's dedicated socket name (see scripts/tmux/launch.sh). */
const CC_SOCKET = "claude";

/** Upper bound on one tmux invocation. A wedged server would otherwise hang every request. */
const TMUX_TIMEOUT_MS = 5_000;

/** `tmux -S <path>` when a socket path is known, else `tmux -L claude`. */
export function tmuxBase(target?: { socket?: string }): string[] {
  return target?.socket
    ? ["tmux", "-S", target.socket]
    : ["tmux", "-L", CC_SOCKET];
}

export function runTmux(argv: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  try {
    const r = Bun.spawnSync(argv, { timeout: TMUX_TIMEOUT_MS });
    return {
      ok: r.exitCode === 0,
      stdout: (r.stdout ?? Buffer.alloc(0)).toString(),
      stderr: (r.stderr ?? Buffer.alloc(0)).toString().trim(),
    };
  } catch (e) {
    // Bun.spawnSync THROWS on a missing binary (ENOENT) — e.g. tmux absent from
    // the launchd PATH. Return an error rather than crashing the handler.
    return { ok: false, stdout: "", stderr: `tmux not runnable: ${String(e)}` };
  }
}

/**
 * `list-panes` exits non-zero when NO server runs on the socket — the legitimate
 * "you have zero sessions" case, not a failure. Anything else (tmux missing,
 * socket permissions) is real and the user must see it.
 */
export function isNoServer(stderr: string): boolean {
  // Our own ENOENT wrapper can contain "no such file or directory", which IS a
  // real failure. Check it first.
  if (/not runnable/i.test(stderr)) return false;
  return /no server running|error connecting to/i.test(stderr);
}

/**
 * Read a pane's visible screen. Returns `""` on ANY failure — non-zero exit,
 * missing binary, or timeout.
 *
 * Callers MUST treat `""` as UNKNOWN STATE and never press Enter on it. Failing
 * closed costs a retry; failing open silently confirms a modal dialog.
 */
export function capturePane(target: TmuxTarget): string {
  const r = runTmux([
    ...tmuxBase(target),
    "capture-pane",
    "-p",
    "-t",
    target.pane,
  ]);
  return r.ok ? r.stdout : "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/tmux-exec.test.ts`
Expected: PASS (8 expect calls)

- [ ] **Step 5: Rewire `tmux.ts` onto the seam**

In `src/handlers/commands/tmux.ts`:

Delete the local `function runTmux(...)` (around line 181) and the local `export function isNoServer(...)` (around line 207). Replace the `CC_SOCKET` const usage in `listPanesArgs`/`captureArgs`/`killArgs` by keeping them as-is (they already emit `-L claude`), and add at the top of the imports:

```ts
import { runTmux, isNoServer } from "../../tmux/exec";
```

Then re-export `isNoServer` so the existing test file keeps importing it from here:

```ts
export { isNoServer } from "../../tmux/exec";
```

- [ ] **Step 6: Verify nothing regressed**

Run: `bun test src/__tests__/tmux-command.test.ts && bun run typecheck`
Expected: PASS, and typecheck silent. `tmux-command.test.ts` imports `isNoServer` from `../handlers/commands/tmux`; the re-export keeps that green.

- [ ] **Step 7: Commit**

```bash
git add src/tmux/exec.ts src/__tests__/tmux-exec.test.ts src/handlers/commands/tmux.ts
git commit -m "refactor(tmux): extract the tmux IO seam into src/tmux/exec.ts

Unifies the two ways the codebase named the same tmux server (-L claude vs
-S <path>) and adds a 5s timeout so a wedged server cannot hang a request.
capturePane returns \"\" on any failure — callers must read that as unknown."
```

---

### Task 2: Capture fixtures and port the modal detector

This is the security core. Everything downstream trusts it.

**Fixtures are already captured and committed** (Claude Code 2.1.206, pane 120x50 and 120x20).
The capture run empirically confirmed the design's two load-bearing premises and
turned up one limitation:

- `tmux send-keys -l <text>` into a Bash-permission dialog **is a no-op** — a
  `ZZPROBEZZ` probe never appeared in the pane, and the pending `touch` never ran.
- The Bash-permission dialog pre-highlights `❯ 1. Yes`, so a bare `Enter` would
  have approved it. The hazard is real, not theoretical.
- **`/usage` carries no capital-E footer token on 2.1.206.** Gate A is blind to it,
  so the watchdog will not alert on a `/usage`-blocked session. The send guard is
  still safe: Gate B finds no input bar and refuses. Both facts are asserted in
  the tests, not papered over.
- `chrome-modal`'s footer is `Esc to keep browser tools off`, which the Esc list
  does not match. Gate A survives only via `Enter to confirm` — that alternative
  is load-bearing, and there is a test pinning it.

Do NOT re-capture. Step 1 is already done; start at Step 2.

**Files:**

- Create: `scripts/tmux/capture-fixtures.sh`
- Create: `src/__tests__/fixtures/tmux-panes/*.txt` (captured, see Step 1)
- Create: `src/tmux/modal-detect.ts`
- Test: `src/__tests__/tmux-modal-detect.test.ts`

**Interfaces:**

- Consumes: nothing (pure module, no imports).
- Produces:
  - `function stripBlankTail(pane: string): string`
  - `function isModalPresent(pane: string): boolean` — Gate A only
  - `function claudeInputBarContent(pane: string): string | null` — both gates
  - `function promptVisibleInPane(before: string, after: string, prompt: string): boolean`

- [ ] **Step 1: Write the fixture-capture script and capture real panes**

Create `scripts/tmux/capture-fixtures.sh`:

```bash
#!/usr/bin/env bash
# Capture a LIVE Claude Code pane into a test fixture.
#
# Fixtures must be captured, never hand-authored: a written fixture encodes our
# belief about how a dialog renders, so the guard's tests would pass while the
# guard still let Enter through on the real dialog.
#
#   usage: scripts/tmux/capture-fixtures.sh <fixture-name> [pane-id]
set -euo pipefail

name="${1:?usage: capture-fixtures.sh <fixture-name> [pane-id]}"
pane="${2:-}"
dir="src/__tests__/fixtures/tmux-panes"
mkdir -p "$dir"

if [[ -z "$pane" ]]; then
  pane="$(tmux -L claude list-panes -a -F '#{pane_id}' | head -1)"
  echo "no pane given; using first: $pane" >&2
fi

tmux -L claude capture-pane -p -t "$pane" > "$dir/$name.txt"
echo "captured $dir/$name.txt ($(wc -l < "$dir/$name.txt" | tr -d ' ') lines)"
```

Make it executable: `chmod +x scripts/tmux/capture-fixtures.sh`

Now capture each state. Start Claude under tmux (`tmux -L claude new -s fixtures`, then `claude` inside it), reach each state, and run the script from another terminal:

| Fixture                | How to reach the state                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `idle-bar.txt`         | Claude at rest, empty input bar                                                                    |
| `idle-bar-typed.txt`   | Type `hello world this is a test` into the bar, do NOT press Enter                                 |
| `thinking.txt`         | Send any prompt; capture while it streams (footer reads lowercase `esc to interrupt`)              |
| `bash-permission.txt`  | Ask Claude to run `ls`; capture while the permission dialog is up                                  |
| `trust-dialog.txt`     | Start Claude in a directory it has never seen                                                      |
| `model-picker.txt`     | Type `/model`, capture with the picker open                                                        |
| `usage.txt`            | Type `/usage`, capture with the panel open                                                         |
| `scrollback-quote.txt` | Ask Claude to print the literal line `Esc to cancel` in its output, let it finish, capture at idle |
| `modal-tall.txt`       | Any modal, pane height ~50 (`tmux resize-window -t fixtures -y 50`)                                |
| `modal-short.txt`      | The SAME modal, pane height ~20 (`tmux resize-window -t fixtures -y 20`)                           |

**If a state cannot be captured, do not fabricate it.** Skip its test with `test.skip` and a comment naming the missing fixture. A skipped test is honest; a fabricated fixture is a lie that hides the bug this task exists to prevent.

After capturing, verify the discriminator actually holds — this is the assumption the whole detector rests on:

```bash
grep -c "Esc to cancel\|Esc to exit\|Enter to confirm" src/__tests__/fixtures/tmux-panes/bash-permission.txt   # expect >= 1
grep -ci "esc to interrupt" src/__tests__/fixtures/tmux-panes/thinking.txt                                     # expect >= 1
grep -c "Esc to" src/__tests__/fixtures/tmux-panes/thinking.txt                                                # expect 0 (capital E absent)
```

If the last command returns non-zero, STOP: Claude's footer wording has changed and Gate A's premise is wrong. Report it rather than adjusting the fixture.

- [ ] **Step 2: Write the failing test**

Create `src/__tests__/tmux-modal-detect.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  stripBlankTail,
  isModalPresent,
  claudeInputBarContent,
  promptVisibleInPane,
} from "../tmux/modal-detect";

const FIXTURES = join(import.meta.dir, "fixtures", "tmux-panes");
const pane = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.txt`), "utf8");

/**
 * True when a fixture was captured. Gate tests on this with `test.skipIf(!has(x))`.
 * A missing fixture must SKIP, never be fabricated: a hand-authored pane encodes
 * our belief about how a dialog renders, so the test would pass while the guard
 * still let Enter through on the real dialog.
 */
const has = (name: string): boolean =>
  existsSync(join(FIXTURES, `${name}.txt`));

/**
 * States that DO carry a Gate A footer token, verified by capture on Claude Code
 * 2.1.206. `usage` is deliberately NOT here — see USAGE_BLIND below.
 */
const MODALS = [
  "bash-permission",
  "trust-dialog",
  "chrome-modal",
  "model-picker",
].filter(has);

/**
 * `/usage` blocks keyboard input but renders NO capital-E footer token on 2.1.206.
 * Gate A is therefore blind to it, and the watchdog will not alert on a
 * /usage-blocked session. The SEND GUARD is still safe, because Gate B finds no
 * input bar and refuses. Captured to pin exactly that asymmetry.
 */
const USAGE_BLIND = "usage";

describe("fixture coverage", () => {
  test("modal fixtures exist — else every assertion below is vacuous", () => {
    expect(MODALS.length).toBe(4);
  });

  test("the idle-vs-modal discriminator holds: idle never says capital 'Esc to'", () => {
    // Gate A's entire premise. If this fails, Claude's footer wording changed
    // and the detector is dead — report it, do not adjust the fixture.
    expect(pane("thinking")).not.toMatch(/Esc to/);
    expect(pane("idle-bar")).not.toMatch(/Esc to/);
  });

  test("thinking says LOWERCASE 'esc to interrupt' — the other side of the discriminator", () => {
    expect(pane("thinking")).toMatch(/esc to interrupt/);
  });
});

describe("stripBlankTail", () => {
  test("drops trailing blank rows, keeps interior blanks", () => {
    expect(stripBlankTail("a\n\nb\n\n  \n\n")).toBe("a\n\nb");
  });

  test("empty pane stays empty", () => {
    expect(stripBlankTail("")).toBe("");
  });
});

describe("isModalPresent — Gate A", () => {
  for (const name of MODALS) {
    test(`fires on ${name}`, () => {
      expect(isModalPresent(pane(name))).toBe(true);
    });
  }

  test("does not fire on the idle bar", () => {
    expect(isModalPresent(pane("idle-bar"))).toBe(false);
  });

  test("does not fire while thinking (lowercase 'esc to interrupt')", () => {
    expect(isModalPresent(pane("thinking"))).toBe(false);
  });

  test("does not fire when scrollback merely quotes 'Esc to cancel'", () => {
    expect(isModalPresent(pane("scrollback-quote"))).toBe(false);
  });

  test("empty pane is not a modal — an unreadable pane must never raise an alert", () => {
    expect(isModalPresent("")).toBe(false);
  });

  test("same modal, different pane heights, same verdict", () => {
    // modal-tall/modal-short are the SAME Bash-permission dialog captured at
    // pane heights 50 and 20. In the tall capture the footer token sits at line
    // 45 of 50 — the last five rows are tmux padding. Without stripBlankTail a
    // last-5-lines scan finds the token in `short` and misses it in `tall`:
    // one TUI state, two opposite verdicts.
    expect(isModalPresent(pane("modal-tall"))).toBe(true);
    expect(isModalPresent(pane("modal-short"))).toBe(true);
  });

  test("chrome-modal fires via 'Enter to confirm', not via the Esc list", () => {
    // Its footer reads "Esc to keep browser tools off" — NOT in
    // Esc to (cancel|clear|exit|dismiss|close). Gate A survives only because of
    // the `Enter to confirm` alternative, so that alternative is load-bearing.
    expect(pane("chrome-modal")).not.toMatch(
      /Esc to (cancel|clear|exit|dismiss|close)/,
    );
    expect(pane("chrome-modal")).toMatch(/Enter to confirm/);
    expect(isModalPresent(pane("chrome-modal"))).toBe(true);
  });

  test("KNOWN BLIND SPOT: /usage blocks input but carries no Gate A token", () => {
    // Documents a real limitation on Claude Code 2.1.206: the watchdog will not
    // alert on a /usage-blocked session. Asserted, not wished away.
    expect(isModalPresent(pane(USAGE_BLIND))).toBe(false);
  });
});

describe("/usage — Gate A is blind, Gate B still protects the guard", () => {
  test("no input bar is found, so delivery is never reported", () => {
    expect(claudeInputBarContent(pane(USAGE_BLIND))).toBeNull();
    expect(
      promptVisibleInPane(pane("idle-bar"), pane(USAGE_BLIND), "/clear"),
    ).toBe(false);
  });
});

describe("claudeInputBarContent — Gate B", () => {
  test("extracts typed text from the framed idle bar", () => {
    expect(claudeInputBarContent(pane("idle-bar-typed"))).toContain(
      "hello world",
    );
  });

  test("returns null for every modal (menu cursor is not a framed bar)", () => {
    for (const name of MODALS) {
      expect(claudeInputBarContent(pane(name))).toBeNull();
    }
  });
});

describe("promptVisibleInPane — the security assertion", () => {
  test("NEVER reports delivery into a modal, for any prompt", () => {
    for (const name of MODALS) {
      const modal = pane(name);
      expect(promptVisibleInPane(pane("idle-bar"), modal, "/clear")).toBe(
        false,
      );
      // A prompt whose head collides with modal menu text must still be refused.
      expect(promptVisibleInPane(pane("idle-bar"), modal, "Yes")).toBe(false);
      expect(
        promptVisibleInPane(pane("idle-bar"), modal, "1. Yes, allow"),
      ).toBe(false);
    }
  });

  test("unknown state (empty after-pane) is not delivery", () => {
    expect(promptVisibleInPane(pane("idle-bar"), "", "/clear")).toBe(false);
  });

  test("reports delivery when the prompt lands in the bar", () => {
    expect(
      promptVisibleInPane(
        pane("idle-bar"),
        pane("idle-bar-typed"),
        "hello world this is a test",
      ),
    ).toBe(true);
  });

  test("carry-over is not delivery — head already in the before-bar", () => {
    expect(
      promptVisibleInPane(
        pane("idle-bar-typed"),
        pane("idle-bar-typed"),
        "hello world this is a test",
      ),
    ).toBe(false);
  });
});
```

Synthetic-bar tests (these construct bars rather than capture them — legitimate, because they exercise _normalization_, not Claude's rendering):

```ts
const SEP = "─".repeat(40);
const bar = (...lines: string[]): string =>
  [SEP, ...lines, SEP, "  ? for shortcuts"].join("\n");

describe("normalization and placeholders", () => {
  test("matches through word-wrap and the 2-space continuation indent", () => {
    const after = bar(
      "❯ File: /very/long/path/that/wrapped",
      "  and-continued-here",
    );
    expect(
      promptVisibleInPane(
        bar("❯ "),
        after,
        "File: /very/long/path/that/wrapped and-continued-here",
      ),
    ).toBe(true);
  });

  test("a NEW [Pasted text #N] placeholder counts as delivery", () => {
    expect(
      promptVisibleInPane(
        bar("❯ "),
        bar("❯ [Pasted text #1]"),
        "x".repeat(2000),
      ),
    ).toBe(true);
  });

  test("a STALE placeholder does not — count must increase", () => {
    const same = bar("❯ [Pasted text #1]");
    expect(promptVisibleInPane(same, same, "x".repeat(2000))).toBe(false);
  });

  test("a short first line cannot collide its way to a false delivery", () => {
    expect(
      promptVisibleInPane(bar("❯ "), bar("❯ some unrelated ok text"), "ok"),
    ).toBe(false);
  });

  test("a ❯ menu cursor without a frame is not a bar", () => {
    expect(claudeInputBarContent("❯ 1. Yes\n  2. No\n")).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/__tests__/tmux-modal-detect.test.ts`
Expected: FAIL — `Cannot find module '../tmux/modal-detect'`

- [ ] **Step 4: Write the implementation**

Create `src/tmux/modal-detect.ts`:

```ts
/**
 * Is the Claude Code TUI accepting keyboard input, or is a modal blocking it?
 *
 * WHY send-and-verify rather than a regex preflight
 * -------------------------------------------------
 * Claude blocks input behind dialogs (trust, Bash permission, sensitive-file
 * edit, /usage, /mcp, /login, /config, /model, /status). When a modal is up:
 *   - `tmux send-keys -l <text>` is a NO-OP; characters never reach the buffer.
 *   - `tmux send-keys Enter` CONFIRMS THE HIGHLIGHTED ITEM — silently approving
 *     a shell command, a sensitive-file edit, or a model switch.
 *
 * A regex preflight on "Esc to cancel" works for today's dialogs and breaks the
 * day Claude ships one with new wording. So we never predict; we observe:
 *   1. Type the text with `-l` (no-op on a modal, harmless otherwise).
 *   2. Wait a render tick.
 *   3. Re-capture the pane.
 *   4. If the prompt head appears in the input bar, input was accepted → Enter.
 *   5. If it does not, a modal ate it → refuse, and tell the user.
 *
 * Ported from pavel-molyanov/telegram-ai-agent `core/tui/modal_detect.py`,
 * whose constants were verified live against Claude Code 2.1.117-2.1.119.
 *
 * This module is PURE — no subprocess, no IO. That is what makes the "Enter
 * never lands in a dialog" property testable against captured fixture panes.
 */

/** First N non-blank chars of the prompt; enough to be unique in the bar. */
const PROMPT_HEAD_CHARS = 30;

/**
 * Minimum first-line length for the first-line-only fallback. Below this, a line
 * like "ok" could collide with unrelated pane text and fake a delivery.
 */
const FIRST_LINE_MIN_LEN = 10;

/** Claude prepends this indent to every input-bar continuation line. */
const CC_CONTINUATION_INDENT = "  ";

/** How far up to hunt for the `❯` bar marker. Long pastes wrap it across rows. */
const INPUT_BAR_SEARCH_LINES = 80;

/**
 * Modal footers render within ~3 lines of the pane bottom. 5 is a safe margin
 * that still excludes scrollback which merely quotes "Esc to cancel".
 */
const MODAL_FOOTER_SCAN_LINES = 5;

const INPUT_BAR_MARKER_RE = /^\s*❯\s?(.*)$/;
const BAR_SEPARATOR_RE = /^\s*─{10,}\s*$/;

/**
 * Every interactive modal advertises its dismiss keys with a CAPITAL E. Non-modal
 * states (idle, thinking, compacting) use lowercase `esc to interrupt`. That case
 * difference is the entire discriminator.
 */
const MODAL_FOOTER_TOKEN_RE =
  /\bEsc to (cancel|clear|exit|dismiss|close)\b|\bEnter to confirm\b/;

/** Claude collapses long bracketed pastes into a literal placeholder chip. */
const PASTED_PLACEHOLDER_RE =
  /\[(?:Pasted text #\d+(?: \+\d+ lines?)?|Pasted Content \d+ chars)\]/gi;

/**
 * Drop trailing blank rows. tmux nondeterministically pads a pane to its
 * configured height or trims it, depending on recent IO. Without this, a
 * last-N-lines scan counts from the physical bottom and a modal footer slips out
 * of the window — the same TUI state then yields opposite verdicts at different
 * pane heights.
 */
export function stripBlankTail(pane: string): string {
  const lines = pane.split("\n");
  while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.join("\n");
}

/** Collapse every whitespace run to one space; strip the ends. */
function wsCollapse(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}

function promptHead(prompt: string): string {
  return prompt.replace(/^\s+/, "").slice(0, PROMPT_HEAD_CHARS);
}

function countPlaceholders(s: string): number {
  return [...s.matchAll(PASTED_PLACEHOLDER_RE)].length;
}

/**
 * Gate A in isolation: does the footer carry a modal dismiss token?
 *
 * Used by the watchdog. Gate B is deliberately NOT applied here: it returns "no
 * bar" on any transient render (startup, mid-tick refresh, empty capture), and a
 * watchdog gated on it would alert constantly.
 *
 * An empty pane is NOT a modal — an unreadable pane must never raise an alert.
 */
export function isModalPresent(pane: string): boolean {
  if (!pane) return false;
  const lines = stripBlankTail(pane)
    .split("\n")
    .slice(-MODAL_FOOTER_SCAN_LINES);
  return MODAL_FOOTER_TOKEN_RE.test(lines.join("\n"));
}

/**
 * The text currently inside the input bar, or null if no bar is rendered (modal /
 * broken layout / unknown). Both gates must pass.
 *
 * Gate A — modal-footer sniff. Handles a modal that happens to render something
 * resembling an idle sandwich.
 *
 * Gate B — structural sandwich. The idle bar is `─────` / `❯ text` / `─────`.
 * Modals contain `❯` as a MENU CURSOR (`❯ 1. Yes`) but lack the frame. This is
 * what stops a prompt head matching modal menu text from faking a delivery.
 *
 * The returned text is a lossy approximation: the continuation indent is
 * stripped, which also mutates any legitimate 2-space line leads the user typed.
 * Callers needing an exact echo must use the stored prompt instead.
 */
export function claudeInputBarContent(pane: string): string | null {
  if (!pane) return null;
  const lines = stripBlankTail(pane).split("\n").slice(-INPUT_BAR_SEARCH_LINES);

  // Gate A — last few lines only. A wider window false-positives on scrollback
  // that quotes "Esc to cancel" inside documentation or code.
  const footer = lines.slice(-MODAL_FOOTER_SCAN_LINES).join("\n");
  if (MODAL_FOOTER_TOKEN_RE.test(footer)) return null;

  // Gate B — walk bottom-up to the first `❯`, require separators above AND below.
  for (let idx = lines.length - 1; idx >= 0; idx--) {
    const m = INPUT_BAR_MARKER_RE.exec(lines[idx]!);
    if (!m) continue;

    const hasFrameAbove = lines
      .slice(Math.max(0, idx - 3), idx)
      .some((l) => BAR_SEPARATOR_RE.test(l));

    let hasFrameBelow = false;
    for (const cont of lines.slice(idx + 1)) {
      if (BAR_SEPARATOR_RE.test(cont)) {
        hasFrameBelow = true;
        break;
      }
      if (INPUT_BAR_MARKER_RE.test(cont)) break;
    }
    if (!hasFrameAbove || !hasFrameBelow) return null;

    const parts: string[] = [m[1] ?? ""];
    for (const cont of lines.slice(idx + 1)) {
      if (BAR_SEPARATOR_RE.test(cont)) break;
      if (INPUT_BAR_MARKER_RE.test(cont)) break;
      parts.push(
        cont.startsWith(CC_CONTINUATION_INDENT)
          ? cont.slice(CC_CONTINUATION_INDENT.length)
          : cont,
      );
    }
    return parts.join("\n");
  }
  return null;
}

function promptVisibleInBar(
  beforeBar: string | null,
  afterBar: string | null,
  prompt: string,
): boolean {
  const head = promptHead(prompt);
  if (!head || afterBar === null) return false;

  const headNorm = wsCollapse(head);
  const afterNorm = wsCollapse(afterBar);
  const beforeNorm = beforeBar ? wsCollapse(beforeBar) : "";

  // 1. ANCHORED normalized-head match, minus scrollback carry-over. The bar
  //    echoes from position 0, so a delivered prompt is a PREFIX of the bar.
  //    Anchoring — NOT a length floor — is what makes the Step 2 "ok" collision
  //    test pass. A floor here would hard-wire this false for `/clear` (6 chars),
  //    `/compact`, `/context`, `y`, `1`, i.e. every payload this feature sends.
  if (headNorm && afterNorm.startsWith(headNorm)) {
    return !(beforeNorm && beforeNorm.startsWith(headNorm));
  }

  // 2. A NEW paste placeholder. Claude collapses payloads above ~1500 chars, so
  //    the head never renders — but a fresh chip proves bytes reached the buffer.
  const afterPastes = countPlaceholders(afterBar);
  if (afterPastes > 0 && afterPastes > countPlaceholders(beforeBar ?? "")) {
    return true;
  }

  // 3. First-line-only fallback for a future Claude transform we do not know
  //    about. Guarded by a length floor against short-substring collisions.
  const firstLine = wsCollapse(head.split("\n", 1)[0] ?? "");
  if (firstLine.length >= FIRST_LINE_MIN_LEN && afterNorm.includes(firstLine)) {
    return !(beforeNorm && beforeNorm.includes(firstLine));
  }

  return false;
}

/**
 * True iff the prompt head is inside `after`'s input bar and was not already
 * inside `before`'s.
 *
 * Closes three false-positive classes:
 *   (a) modal overlay — `after` has no bar, so we never report delivery even if
 *       the modal body contains text matching the head. SECURITY-CRITICAL: this
 *       is what keeps Enter out of a dialog.
 *   (b) lingering scrollback — the head was already in the bar from a prior send.
 *   (c) stale paste placeholder — same chip persists across the send.
 */
export function promptVisibleInPane(
  before: string,
  after: string,
  prompt: string,
): boolean {
  return promptVisibleInBar(
    claudeInputBarContent(before),
    claudeInputBarContent(after),
    prompt,
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/__tests__/tmux-modal-detect.test.ts`
Expected: PASS. If `promptVisibleInPane` reports `true` for any modal fixture, STOP — that is the exact security bug; do not adjust the test to accommodate it.

- [ ] **Step 6: Commit**

```bash
chmod +x scripts/tmux/capture-fixtures.sh
git add scripts/tmux/capture-fixtures.sh src/tmux/modal-detect.ts \
        src/__tests__/tmux-modal-detect.test.ts src/__tests__/fixtures/tmux-panes/
git commit -m "feat(tmux): two-gate modal detector, pure, against captured panes

Gate A sniffs the capital-E footer dismiss token (idle says lowercase 'esc to
interrupt'). Gate B requires the framed input-bar sandwich, so a modal's menu
cursor cannot pass as a bar. promptVisibleInPane returns false for every
captured modal — that assertion is what keeps Enter out of a dialog."
```

---

### Task 3: Key map, keyboard builder, callback parser

**Files:**

- Create: `src/tmux/keys.ts`
- Test: `src/__tests__/tmux-keys.test.ts`

**Interfaces:**

- Consumes: `InlineKeyboard` from `grammy`.
- Produces:
  - `type TuiAction` (union of the 21 action strings)
  - `const TUI_ACTIONS: readonly TuiAction[]`
  - `function tuiKeyArgv(action: string): string[] | null` — `[]` for `refresh`/`close`, `null` for unknown
  - `function buildTuiKeyboard(launchUuid: string): InlineKeyboard`
  - `function parseTuiCallback(data: string): { action: TuiAction; launchUuid: string } | null`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/tmux-keys.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import {
  TUI_ACTIONS,
  tuiKeyArgv,
  buildTuiKeyboard,
  parseTuiCallback,
} from "../tmux/keys";

const UUID = "01234567-89ab-cdef-0123-456789abcdef"; // 36 chars

describe("tuiKeyArgv", () => {
  test("maps every key action to tmux argv", () => {
    expect(tuiKeyArgv("up")).toEqual(["Up"]);
    expect(tuiKeyArgv("dn")).toEqual(["Down"]);
    expect(tuiKeyArgv("lt")).toEqual(["Left"]);
    expect(tuiKeyArgv("rt")).toEqual(["Right"]);
    expect(tuiKeyArgv("ent")).toEqual(["Enter"]);
    expect(tuiKeyArgv("bsp")).toEqual(["BSpace"]);
    expect(tuiKeyArgv("esc")).toEqual(["Escape"]);
    expect(tuiKeyArgv("tab")).toEqual(["Tab"]);
    expect(tuiKeyArgv("btab")).toEqual(["BTab"]);
    expect(tuiKeyArgv("cC")).toEqual(["C-c"]);
    expect(tuiKeyArgv("cU")).toEqual(["C-u"]);
    expect(tuiKeyArgv("cO")).toEqual(["C-o"]);
    expect(tuiKeyArgv("cR")).toEqual(["C-r"]);
    expect(tuiKeyArgv("cT")).toEqual(["C-t"]);
    expect(tuiKeyArgv("num0")).toEqual(["0"]);
    expect(tuiKeyArgv("num1")).toEqual(["1"]);
    expect(tuiKeyArgv("num2")).toEqual(["2"]);
    expect(tuiKeyArgv("num3")).toEqual(["3"]);
  });

  test("esc2 sends two Escapes", () => {
    expect(tuiKeyArgv("esc2")).toEqual(["Escape", "Escape"]);
  });

  test("refresh and close send no keys", () => {
    expect(tuiKeyArgv("refresh")).toEqual([]);
    expect(tuiKeyArgv("close")).toEqual([]);
  });

  test("an unknown action returns null — never reaches send-keys", () => {
    expect(tuiKeyArgv("rm -rf /")).toBeNull();
    expect(tuiKeyArgv("")).toBeNull();
    expect(tuiKeyArgv("Enter")).toBeNull(); // raw tmux key names are not actions
  });

  test("there are exactly 21 actions", () => {
    expect(TUI_ACTIONS.length).toBe(21);
  });
});

describe("parseTuiCallback", () => {
  test("round-trips every action through the keyboard", () => {
    const kb = buildTuiKeyboard(UUID);
    const datas = kb.inline_keyboard
      .flat()
      .map((b) => (b as { callback_data: string }).callback_data);
    expect(datas.length).toBe(21);
    for (const d of datas) {
      const parsed = parseTuiCallback(d);
      expect(parsed).not.toBeNull();
      expect(parsed!.launchUuid).toBe(UUID);
      expect(TUI_ACTIONS).toContain(parsed!.action);
    }
  });

  test("callback data fits Telegram's 64-byte limit", () => {
    for (const row of buildTuiKeyboard(UUID).inline_keyboard) {
      for (const btn of row) {
        const d = (btn as { callback_data: string }).callback_data;
        expect(Buffer.byteLength(d, "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });

  test("rejects a wrong prefix, unknown action, or missing uuid", () => {
    expect(parseTuiCallback(`tmux:up:${UUID}`)).toBeNull();
    expect(parseTuiCallback(`tui:bogus:${UUID}`)).toBeNull();
    expect(parseTuiCallback("tui:up:")).toBeNull();
    expect(parseTuiCallback("tui:up")).toBeNull();
  });

  test("keyboard has the 4-row layout", () => {
    const kb = buildTuiKeyboard(UUID);
    expect(kb.inline_keyboard.map((r) => r.length)).toEqual([4, 6, 4, 7]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/tmux-keys.test.ts`
Expected: FAIL — `Cannot find module '../tmux/keys'`

- [ ] **Step 3: Write the implementation**

Create `src/tmux/keys.ts`:

```ts
/**
 * The /tui inline keyboard: action names, their tmux key argv, and the callback
 * contract.
 *
 * Callback data is `tui:<action>:<launchUuid>` — 4 + ≤5 + 1 + 36 = 46 bytes,
 * inside Telegram's 64-byte limit.
 *
 * There is deliberately NO epoch/session-id field (the upstream project carries
 * one to reject stale keyboards). We re-resolve the launchUuid to its CURRENT
 * pane on every tap, which is a stronger guard: it also survives a session-id
 * change from /clear.
 */

import { InlineKeyboard } from "grammy";

/** Every action the panel can emit. `refresh`/`close` send no keys. */
export const TUI_ACTIONS = [
  "up",
  "dn",
  "lt",
  "rt",
  "ent",
  "bsp",
  "esc",
  "esc2",
  "tab",
  "btab",
  "num1",
  "num2",
  "num3",
  "num0",
  "cC",
  "cU",
  "cO",
  "cR",
  "cT",
  "refresh",
  "close",
] as const;

export type TuiAction = (typeof TUI_ACTIONS)[number];

/** action → `tmux send-keys` arguments. Empty array = issues no send-keys. */
const KEY_ARGV: Record<TuiAction, string[]> = {
  up: ["Up"],
  dn: ["Down"],
  lt: ["Left"],
  rt: ["Right"],
  ent: ["Enter"],
  bsp: ["BSpace"],
  esc: ["Escape"],
  esc2: ["Escape", "Escape"],
  tab: ["Tab"],
  btab: ["BTab"],
  num1: ["1"],
  num2: ["2"],
  num3: ["3"],
  num0: ["0"],
  cC: ["C-c"],
  cU: ["C-u"],
  cO: ["C-o"],
  cR: ["C-r"],
  cT: ["C-t"],
  refresh: [],
  close: [],
};

function isTuiAction(s: string): s is TuiAction {
  return (TUI_ACTIONS as readonly string[]).includes(s);
}

/**
 * tmux argv for an action, or `null` if unknown. Returning null (rather than a
 * passthrough) is what stops an arbitrary callback string reaching `send-keys`.
 */
export function tuiKeyArgv(action: string): string[] | null {
  return isTuiAction(action) ? [...KEY_ARGV[action]] : null;
}

/**
 * The 4-row panel:
 *   row 1  ⬆️ ⬇️ ⬅️ ➡️
 *   row 2  ↩️ ⌫ Esc Esc2 Tab ⇧Tab
 *   row 3  1 2 3 0
 *   row 4  ⌃C ⌃U ⌃O ⌃R ⌃T 🔄 Close
 */
export function buildTuiKeyboard(launchUuid: string): InlineKeyboard {
  const cb = (a: TuiAction): string => `tui:${a}:${launchUuid}`;
  const kb = new InlineKeyboard();

  kb.text("⬆️", cb("up"))
    .text("⬇️", cb("dn"))
    .text("⬅️", cb("lt"))
    .text("➡️", cb("rt"))
    .row();

  kb.text("↩️", cb("ent"))
    .text("⌫", cb("bsp"))
    .text("Esc", cb("esc"))
    .text("Esc 2", cb("esc2"))
    .text("Tab", cb("tab"))
    .text("⇧Tab", cb("btab"))
    .row();

  kb.text("1", cb("num1"))
    .text("2", cb("num2"))
    .text("3", cb("num3"))
    .text("0", cb("num0"))
    .row();

  kb.text("⌃C", cb("cC"))
    .text("⌃U", cb("cU"))
    .text("⌃O", cb("cO"))
    .text("⌃R", cb("cR"))
    .text("⌃T", cb("cT"))
    .text("🔄", cb("refresh"))
    .text("✕", cb("close"));

  return kb;
}

/** Parse `tui:<action>:<launchUuid>`. Null on any validation failure. */
export function parseTuiCallback(
  data: string,
): { action: TuiAction; launchUuid: string } | null {
  if (!data.startsWith("tui:")) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [, action, launchUuid] = parts;
  if (!action || !launchUuid) return null;
  if (!isTuiAction(action)) return null;
  return { action, launchUuid };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/tmux-keys.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tmux/keys.ts src/__tests__/tmux-keys.test.ts
git commit -m "feat(tmux): /tui key map, 4-row keyboard, callback parser

tui:<action>:<launchUuid> is 46 bytes. Unknown actions parse to null rather
than passing an arbitrary string to send-keys. No epoch field: re-resolving
the launchUuid per tap is a stronger stale-keyboard guard."
```

---

### Task 4: Attach the panel to `/peek` and handle `tui:*` taps

**Files:**

- Modify: `src/handlers/commands/tmux.ts` (`sendCapture`, new `handleTuiCallback`, new `replyBlockedPanel`)
- Modify: `src/handlers/callback.ts` (route `tui:`)
- Test: `src/__tests__/tmux-tui-callback.test.ts`

**Interfaces:**

- Consumes: `capturePane`, `TmuxTarget` (Task 1); `buildTuiKeyboard`, `parseTuiCallback`, `tuiKeyArgv` (Task 3).
- Produces:
  - `function handleTuiCallback(ctx: Context, data: string): Promise<void>`
  - `function replyBlockedPanel(ctx: Context, launchUuid: string, pane: string): Promise<void>`
  - `function planTuiTap(action: TuiAction): { sendArgv: string[][]; recapture: boolean; closeMsg: boolean }` (pure, exported for tests)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/tmux-tui-callback.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { planTuiTap } from "../handlers/commands/tmux";

describe("planTuiTap", () => {
  test("a key action sends its argv then re-captures", () => {
    const p = planTuiTap("dn");
    expect(p.sendArgv).toEqual([["Down"]]);
    expect(p.recapture).toBe(true);
    expect(p.closeMsg).toBe(false);
  });

  test("esc2 sends both Escapes in ONE send-keys invocation", () => {
    expect(planTuiTap("esc2").sendArgv).toEqual([["Escape", "Escape"]]);
  });

  test("refresh sends nothing but re-captures", () => {
    const p = planTuiTap("refresh");
    expect(p.sendArgv).toEqual([]);
    expect(p.recapture).toBe(true);
  });

  test("close sends nothing, does not re-capture, deletes the message", () => {
    const p = planTuiTap("close");
    expect(p.sendArgv).toEqual([]);
    expect(p.recapture).toBe(false);
    expect(p.closeMsg).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/tmux-tui-callback.test.ts`
Expected: FAIL — `planTuiTap` is not exported from `tmux.ts`

- [ ] **Step 3: Implement in `src/handlers/commands/tmux.ts`**

Add imports at the top:

```ts
import { capturePane } from "../../tmux/exec";
import {
  buildTuiKeyboard,
  parseTuiCallback,
  tuiKeyArgv,
  type TuiAction,
} from "../../tmux/keys";
```

Add the settle constant near `CAPTURE_MAX_ESCAPED`:

```ts
/**
 * Pause after send-keys before re-capturing. Too short and the capture returns
 * pre-keypress state, the edit becomes a no-op ("message is not modified"), and
 * the user stares at a stale TUI. Measured upstream on Claude Code 2.1.118:
 * fast redraws 15-20ms; Escape closing a menu ~80ms; a mid-thinking redraw lands
 * on the next render tick ~200ms. Their original 50ms missed every slow case.
 */
const SEND_KEYS_SETTLE_MS = 500;
```

Add a `send-keys` argv builder next to `captureArgs`:

```ts
export function sendKeysArgs(pane: string, keys: string[]): string[] {
  return ["tmux", "-L", CC_SOCKET, "send-keys", "-t", pane, ...keys];
}
```

Add the pure planner (exported for tests):

```ts
/** What a `tui:` tap must do. Pure — the IO lives in handleTuiCallback. */
export function planTuiTap(action: TuiAction): {
  sendArgv: string[][];
  recapture: boolean;
  closeMsg: boolean;
} {
  if (action === "close")
    return { sendArgv: [], recapture: false, closeMsg: true };
  if (action === "refresh")
    return { sendArgv: [], recapture: true, closeMsg: false };
  const keys = tuiKeyArgv(action) ?? [];
  // One send-keys invocation carrying every key: `esc2` must deliver both
  // Escapes without a round-trip between them.
  return {
    sendArgv: keys.length ? [keys] : [],
    recapture: true,
    closeMsg: false,
  };
}
```

Replace `sendCapture`'s keyboard (currently a lone Refresh button):

```ts
const kb = buildTuiKeyboard(row.launchUuid!);
```

Guard it: `sendCapture` is only reached for rows with a launchUuid (both `/peek` and the `tmux:peek` callback filter on it), so the non-null assertion holds. Make it explicit instead:

```ts
if (!row.launchUuid) {
  const msg = "This session has no launchUuid — the key panel needs one.";
  if (edit) await ctx.editMessageText(msg).catch(() => {});
  else await reply(ctx, msg);
  return;
}
const kb = buildTuiKeyboard(row.launchUuid);
```

Add an in-flight set and the callback handler at the end of the file:

```ts
/**
 * Serialize taps per session. A tap while one is in flight is REJECTED, not
 * queued: a queued keystroke lands in a TUI whose state has already moved on,
 * which is exactly how the wrong dialog item gets confirmed.
 */
const inFlight = new Set<string>();

/** Handle a `tui:*` callback. `data` is the full callback string. */
export async function handleTuiCallback(
  ctx: Context,
  data: string,
): Promise<void> {
  if (!authed(ctx)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized." });
    return;
  }
  const parsed = parseTuiCallback(data);
  if (!parsed) {
    await ctx.answerCallbackQuery({ text: "Unknown action" });
    return;
  }
  const { action, launchUuid } = parsed;

  if (action === "close") {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.deleteMessage().catch(() => {});
    return;
  }

  if (inFlight.has(launchUuid)) {
    await ctx.answerCallbackQuery({ text: "busy" });
    return;
  }
  inFlight.add(launchUuid);
  try {
    // Re-resolve every tap: a keyboard outliving its session must never drive
    // another pane. This is the stale-keyboard guard.
    const row = await rowForLaunchUuid(launchUuid);
    if (!row) {
      await ctx.answerCallbackQuery({ text: "Session gone." });
      return;
    }

    const plan = planTuiTap(action);
    await ctx.answerCallbackQuery().catch(() => {});

    for (const keys of plan.sendArgv) {
      const r = runTmux(sendKeysArgs(row.pane, keys));
      if (!r.ok) {
        // The on-screen pane is still accurate; don't edit it, just report.
        await ctx
          .answerCallbackQuery({ text: "send-keys failed" })
          .catch(() => {});
        return;
      }
    }

    if (plan.recapture) {
      if (plan.sendArgv.length) await Bun.sleep(SEND_KEYS_SETTLE_MS);
      await sendCapture(ctx, row, true);
    }
  } finally {
    inFlight.delete(launchUuid);
  }
}
```

Add the blocked-panel renderer (used by Task 5):

```ts
/** Render "your session is blocked on a dialog" with the live pane + key panel. */
export async function replyBlockedPanel(
  ctx: Context,
  launchUuid: string,
  pane: string,
): Promise<void> {
  const body =
    `⚠️ <b>Session is blocked on a dialog.</b>\n` +
    `Nothing was sent. Answer it below.\n\n<pre>${fitEscapedCapture(pane)}</pre>`;
  await reply(ctx, body, {
    format: "html",
    replyMarkup: buildTuiKeyboard(launchUuid),
  });
}
```

- [ ] **Step 4: Route the callback**

In `src/handlers/callback.ts`, import `handleTuiCallback` alongside `handleTmuxCallback` (from `./commands`), and add a branch **before** the `tmux:` branch (they don't collide, but keep them adjacent):

```ts
// /tui key panel: tui:<action>:<launchUuid>
if (callbackData.startsWith("tui:")) {
  await handleTuiCallback(ctx, callbackData);
  return;
}
```

Export `handleTuiCallback` and `replyBlockedPanel` from `src/handlers/commands/index.ts` next to `handleTmuxCallback`.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test src/__tests__/tmux-tui-callback.test.ts && bun test src/__tests__/tmux-command.test.ts && bun run typecheck`
Expected: PASS, typecheck silent.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/commands/tmux.ts src/handlers/commands/index.ts \
        src/handlers/callback.ts src/__tests__/tmux-tui-callback.test.ts
git commit -m "feat(tui): interactive key panel on /peek and the /tmux peek button

Every tap re-resolves the launchUuid to its current pane, so a stale keyboard
cannot drive another session. Taps serialize per session and reject rather
than queue — a queued key lands in a TUI whose state has moved on."
```

---

### Task 5: The send guard — never press Enter into a modal

This is the security fix.

**Files:**

- Modify: `src/handlers/commands/terminal-inject.ts` (`InjectResult`, `sendKeysToSession`)
- Modify: `src/handlers/commands/inject.ts` (render the blocked panel)
- Test: `src/__tests__/tmux-send-guard.test.ts`

**Interfaces:**

- Consumes: `capturePane` (Task 1); `promptVisibleInPane` (Task 2); `replyBlockedPanel` (Task 4).
- Produces:
  - `InjectResult` false variant gains `blocked?: true; pane?: string; launchUuid?: string`
  - `function planGuardedSend(before: string, after: string, text: string): { sendEnter: boolean }` (pure, exported)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/tmux-send-guard.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { planGuardedSend } from "../handlers/commands/terminal-inject";

const FIXTURES = join(import.meta.dir, "fixtures", "tmux-panes");
const pane = (n: string): string =>
  readFileSync(join(FIXTURES, `${n}.txt`), "utf8");

describe("planGuardedSend", () => {
  test("NEVER sends Enter when the after-pane is a modal", () => {
    for (const modal of [
      "bash-permission",
      "trust-dialog",
      "model-picker",
      "usage",
    ]) {
      expect(
        planGuardedSend(pane("idle-bar"), pane(modal), "/clear").sendEnter,
      ).toBe(false);
    }
  });

  test("NEVER sends Enter when the capture failed (unknown state)", () => {
    expect(planGuardedSend(pane("idle-bar"), "", "/clear").sendEnter).toBe(
      false,
    );
    expect(planGuardedSend("", "", "/clear").sendEnter).toBe(false);
  });

  test("sends Enter when the text demonstrably landed in the bar", () => {
    expect(
      planGuardedSend(
        pane("idle-bar"),
        pane("idle-bar-typed"),
        "hello world this is a test",
      ).sendEnter,
    ).toBe(true);
  });

  test("does not send Enter on carry-over from a prior send", () => {
    expect(
      planGuardedSend(
        pane("idle-bar-typed"),
        pane("idle-bar-typed"),
        "hello world this is a test",
      ).sendEnter,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/tmux-send-guard.test.ts`
Expected: FAIL — `planGuardedSend` is not exported

- [ ] **Step 3: Implement the guard**

In `src/handlers/commands/terminal-inject.ts`:

Add imports:

```ts
import { capturePane } from "../../tmux/exec";
import { promptVisibleInPane } from "../../tmux/modal-detect";
```

Widen `InjectResult` (line ~401):

```ts
export type InjectResult =
  | { ok: true; app: TerminalApp; note?: string }
  | {
      ok: false;
      app: TerminalApp;
      reason: string;
      /** A modal ate the input; nothing was sent. Render the pane + key panel. */
      blocked?: true;
      /** The pane as captured at refusal time — only set when `blocked`. */
      pane?: string;
      /** For building the key panel — only set when `blocked` and resolvable. */
      launchUuid?: string;
    };
```

Add the pure planner and the settle constant:

```ts
/** See tmux.ts — same measured value, same reason. */
const SEND_KEYS_SETTLE_MS = 500;

/**
 * Decide whether Enter is safe. Pure.
 *
 * `send-keys -l` into a modal is a NO-OP, so probing costs nothing in the bad
 * case. If our text is not visible in the input bar afterwards, a modal ate it —
 * and a bare Enter would CONFIRM that modal's highlighted item.
 */
export function planGuardedSend(
  before: string,
  after: string,
  text: string,
): { sendEnter: boolean } {
  return { sendEnter: promptVisibleInPane(before, after, text) };
}
```

Rewrite the tmux branch of `sendKeysToSession`:

```ts
const tmux = await resolveTmuxTarget(sctx);
if (tmux) {
  const before = capturePane(tmux);

  // Type the text literally. Harmless if a modal is up: it is a no-op.
  const typed = runTmuxSend(tmux, ["-l", text]);
  if (!typed.ok) {
    return {
      ok: false,
      app: "tmux",
      reason: `tmux send-keys failed (${typed.stderr || "pane gone?"}).`,
    };
  }

  await Bun.sleep(SEND_KEYS_SETTLE_MS);
  const after = capturePane(tmux);

  if (!planGuardedSend(before, after, text).sendEnter) {
    // Do NOT press Enter. An empty `after` (capture failed) lands here too —
    // unknown state must fail closed.
    return {
      ok: false,
      app: "tmux",
      blocked: true,
      pane: after,
      launchUuid: launchUuidForSessionId(sctx.sessionId),
      reason: "the session is blocked on a dialog, so nothing was sent",
    };
  }

  const submitted = runTmuxSend(tmux, ["Enter"]);
  if (!submitted.ok) {
    return {
      ok: false,
      app: "tmux",
      reason: `tmux send-keys failed (${submitted.stderr || "pane gone?"}).`,
    };
  }
  return { ok: true, app: "tmux", note: `sent to tmux pane ${tmux.pane}` };
}
```

Add the small IO helper beside `buildTmuxSendArgs` (and keep `buildTmuxSendArgs` exported — existing tests may reference it; if none do, delete it):

```ts
import { runTmux, tmuxBase } from "../../tmux/exec";

function runTmuxSend(target: TmuxTarget, keys: string[]) {
  return runTmux([
    ...tmuxBase(target),
    "send-keys",
    "-t",
    target.pane,
    ...keys,
  ]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/tmux-send-guard.test.ts`
Expected: PASS. Any `sendEnter === true` against a modal fixture is the bug; do not weaken the test.

- [ ] **Step 5: Surface the blocked state in `/clear`, `/compact`, `/context`**

In `src/handlers/commands/inject.ts`, import the renderer and widen the else branch:

```ts
import { replyBlockedPanel } from "./tmux";
```

```ts
const result = await sendKeysToSession(sctx, slash);
if (result.ok) {
  await busReply(
    ctx,
    result.note ? `${doneLabel} (${result.note})` : doneLabel,
  );
  return;
}
if (result.blocked && result.launchUuid && result.pane) {
  await replyBlockedPanel(ctx, result.launchUuid, result.pane);
  return;
}
await busReply(ctx, `❌ Couldn't send ${slash}: ${result.reason}`);
```

- [ ] **Step 6: Full suite + typecheck**

Run: `bun run typecheck && bun run test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/handlers/commands/terminal-inject.ts src/handlers/commands/inject.ts \
        src/__tests__/tmux-send-guard.test.ts
git commit -m "fix(tmux): never send Enter into a Claude Code modal

buildTmuxSendArgs typed the text then pressed Enter unconditionally. With a
modal up the text is a no-op and the bare Enter CONFIRMS the highlighted item
— approving a shell command, a sensitive-file edit, or a model switch. /clear,
/compact and /context are bot commands, so it was reachable from Telegram.

sendKeysToSession now captures, types, settles 500ms, re-captures, and presses
Enter only when the text is demonstrably in the input bar. An empty capture
(wedged tmux) fails closed. The refusal renders the pane plus the key panel so
the dialog can be answered in place."
```

---

### Task 6: The modal watchdog

**Files:**

- Create: `src/tmux/watchdog.ts`
- Modify: `src/topics/topic-store.ts` (export a `getChatId()` accessor — `store.chatId` is currently private and there is no getter)
- Modify: `src/index.ts` (start it)
- Test: `src/__tests__/tmux-watchdog.test.ts`

**Interfaces:**

- Consumes: `isModalPresent` (Task 2); `listTmuxRows`, `TmuxSessionRow`, `rowLabel`, `fitEscapedCapture` (existing `tmux.ts`); `capturePane` (Task 1); `buildTuiKeyboard` (Task 3); `getTopicByLaunchUuid` (existing, returns `TopicMapping | undefined` with a `topicId: number`).
- Produces:
  - `function getChatId(): number` in `src/topics/topic-store.ts` (returns `0` when unset)
  - `function planModalAlerts(rows, capture, lastAlertedPane): { alerts: Array<{ launchUuid: string; pane: string }>; nextMap: Map<string, string> }` (pure)
  - `function startModalWatchdog(): () => void`

There is no `TELEGRAM_CHAT_ID` in `src/config.ts`. The chat id lives on the topic
store (`TopicStore.chatId`, set via `setChatId`). Add the getter in Step 3a.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/tmux-watchdog.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { planModalAlerts } from "../tmux/watchdog";

const FIXTURES = join(import.meta.dir, "fixtures", "tmux-panes");
const pane = (n: string): string =>
  readFileSync(join(FIXTURES, `${n}.txt`), "utf8");

const MODAL = pane("bash-permission");
const IDLE = pane("idle-bar");

const rows = (...uuids: string[]) =>
  uuids.map((launchUuid) => ({ launchUuid, pane: "%1" }));

describe("planModalAlerts", () => {
  test("alerts once on a modal pane", () => {
    const { alerts, nextMap } = planModalAlerts(
      rows("a"),
      () => MODAL,
      new Map(),
    );
    expect(alerts.map((a) => a.launchUuid)).toEqual(["a"]);
    expect(nextMap.get("a")).toBe(MODAL);
  });

  test("does not re-alert on an unchanged pane", () => {
    const first = planModalAlerts(rows("a"), () => MODAL, new Map());
    const second = planModalAlerts(rows("a"), () => MODAL, first.nextMap);
    expect(second.alerts).toEqual([]);
  });

  test("clears state at idle, then re-alerts on a NEW modal", () => {
    const first = planModalAlerts(rows("a"), () => MODAL, new Map());
    const idle = planModalAlerts(rows("a"), () => IDLE, first.nextMap);
    expect(idle.alerts).toEqual([]);
    expect(idle.nextMap.has("a")).toBe(false);
    const again = planModalAlerts(rows("a"), () => MODAL, idle.nextMap);
    expect(again.alerts.map((a) => a.launchUuid)).toEqual(["a"]);
  });

  test("never alerts on an unreadable pane", () => {
    const { alerts } = planModalAlerts(rows("a"), () => "", new Map());
    expect(alerts).toEqual([]);
  });

  test("a row without a launchUuid is skipped", () => {
    const { alerts } = planModalAlerts(
      [{ launchUuid: undefined, pane: "%1" }],
      () => MODAL,
      new Map(),
    );
    expect(alerts).toEqual([]);
  });

  test("one throwing row does not stop the others", () => {
    const capture = (p: string): string => {
      if (p === "%boom") throw new Error("tmux exploded");
      return MODAL;
    };
    const input = [
      { launchUuid: "a", pane: "%boom" },
      { launchUuid: "b", pane: "%2" },
    ];
    const { alerts } = planModalAlerts(input, capture, new Map());
    expect(alerts.map((a) => a.launchUuid)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/tmux-watchdog.test.ts`
Expected: FAIL — `Cannot find module '../tmux/watchdog'`

- [ ] **Step 3a: Export the chat-id accessor**

In `src/topics/topic-store.ts`, beside `setChatId` (line ~41):

```ts
/** The forum chat every topic lives in. `0` until `setChatId` has run. */
export function getChatId(): number {
  return store.chatId;
}
```

- [ ] **Step 3b: Write the implementation**

Create `src/tmux/watchdog.ts`:

```ts
/**
 * Poll tmux-hosted Claude sessions for a modal that popped while the agent was
 * working autonomously — a Bash-permission prompt, an auto-compact confirmation,
 * a sensitive-file-edit gate.
 *
 * Without this, the send guard only notices a modal when the user next tries to
 * send something, which may be hours later. The session sits blocked and silent.
 *
 * Gate A only (`isModalPresent`). Gate B returns "no bar" on any transient render
 * — startup, a mid-tick refresh, an empty capture — and a watchdog gated on it
 * would alert constantly.
 */

import { isModalPresent } from "./modal-detect";
import { capturePane } from "./exec";
import { warn, info } from "../logger";

/** Independent of the session watcher's 60s poll — far too slow for "you're blocked". */
const WATCHDOG_INTERVAL_MS = 15_000;

export interface WatchdogRow {
  launchUuid?: string;
  pane: string;
}

/**
 * Pure. Decide which sessions deserve an alert this tick.
 *
 * Dedup is on the PANE TEXT itself: an unchanged pane on the next tick is a
 * no-op. When a session leaves the modal, its entry is dropped, so a later
 * second modal alerts again.
 *
 * A capture that throws or returns "" yields no alert — an unreadable pane must
 * never raise one — and never aborts the other rows.
 */
export function planModalAlerts(
  rows: WatchdogRow[],
  capture: (pane: string) => string,
  lastAlertedPane: Map<string, string>,
): {
  alerts: Array<{ launchUuid: string; pane: string }>;
  nextMap: Map<string, string>;
} {
  const alerts: Array<{ launchUuid: string; pane: string }> = [];
  const nextMap = new Map(lastAlertedPane);

  for (const row of rows) {
    if (!row.launchUuid) continue; // no stable key → no dedup, no keyboard
    let pane = "";
    try {
      pane = capture(row.pane);
    } catch (e) {
      warn(`watchdog: capture threw for pane ${row.pane}: ${String(e)}`);
      continue;
    }

    if (!isModalPresent(pane)) {
      nextMap.delete(row.launchUuid);
      continue;
    }
    if (nextMap.get(row.launchUuid) === pane) continue; // already alerted, unchanged

    nextMap.set(row.launchUuid, pane);
    alerts.push({ launchUuid: row.launchUuid, pane });
  }

  return { alerts, nextMap };
}

/**
 * Start the poll loop. Returns a stop function.
 *
 * Every tick is wrapped: a dead watchdog is silent, which is the worst failure
 * mode, so any throw is logged and the timer survives.
 */
export function startModalWatchdog(): () => void {
  let lastAlertedPane = new Map<string, string>();

  const tick = async (): Promise<void> => {
    try {
      // Imported lazily: tmux.ts pulls in grammy + the topic store, and importing
      // it at module load would cycle back through handlers/commands.
      const { listTmuxRows, rowLabel, fitEscapedCapture } =
        await import("../handlers/commands/tmux");
      const { buildTuiKeyboard } = await import("./keys");
      const { getTopicByLaunchUuid, getChatId } =
        await import("../topics/topic-store");
      const { getMessageBus } = await import("../messaging");

      const chatId = getChatId();
      if (!chatId) return; // topic store not initialised yet — nowhere to alert

      const { rows, error } = await listTmuxRows();
      if (error) return;

      const { alerts, nextMap } = planModalAlerts(
        rows,
        capturePane,
        lastAlertedPane,
      );
      lastAlertedPane = nextMap;

      for (const alert of alerts) {
        const topic = getTopicByLaunchUuid(alert.launchUuid);
        if (!topic) continue; // no topic to alert into
        const row = rows.find((r) => r.launchUuid === alert.launchUuid);
        const label = row ? rowLabel(row) : alert.launchUuid.slice(0, 8);
        info(`watchdog: modal detected in ${label}`);
        await getMessageBus().send({
          chatId,
          threadId: topic.topicId,
          content:
            `⚠️ <b>${label} is blocked on a dialog.</b>\n\n` +
            `<pre>${fitEscapedCapture(alert.pane)}</pre>`,
          format: "html",
          replyMarkup: {
            inline_keyboard: buildTuiKeyboard(alert.launchUuid).inline_keyboard,
          },
        });
      }
    } catch (e) {
      warn(`watchdog: tick failed: ${String(e)}`);
    }
  };

  const handle = setInterval(() => void tick(), WATCHDOG_INTERVAL_MS);
  return () => clearInterval(handle);
}
```

All names above are verified against the current tree: `fitEscapedCapture`,
`listTmuxRows`, `rowLabel` are exported from `tmux.ts`; `getTopicByLaunchUuid`
returns a `TopicMapping` with `topicId`; `getMessageBus().send` takes
`{ chatId, threadId, content, format, replyMarkup }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/tmux-watchdog.test.ts`
Expected: PASS

- [ ] **Step 5: Start it**

In `src/index.ts`, after the bot is constructed and the message bus exists, add:

```ts
import { startModalWatchdog } from "./tmux/watchdog";
```

```ts
startModalWatchdog();
```

Place it beside the other background starters (near where the session watcher starts). Do not add a stop call — the process exits with the bot.

- [ ] **Step 6: Full suite + typecheck**

Run: `bun run typecheck && bun run test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/tmux/watchdog.ts src/__tests__/tmux-watchdog.test.ts \
        src/topics/topic-store.ts src/index.ts
git commit -m "feat(tmux): watchdog alerts when a session blocks on a dialog

Polls every 15s (the session watcher's 60s is far too slow for 'you are
blocked'). Gate A only — Gate B returns 'no bar' on transient renders and
would alert constantly. Dedup is on the pane text: an unchanged pane is a
no-op, and leaving the modal re-arms the alert. Alerts carry the key panel."
```

---

## Manual verification (after Task 6)

The unit tests prove the detector against captured panes. They cannot prove the
wiring. Drive it end-to-end once:

1. Start Claude under tmux via the launcher; confirm `/tmux` lists it.
2. `/peek` → the 4-row panel renders under the pane.
3. Tap ⬇️ then ⬆️ in an open `/model` picker — the highlighted row moves in the
   Telegram snapshot.
4. Tap ✕ — the message disappears.
5. Ask Claude to run a shell command so the permission dialog opens. From
   Telegram send `/clear`. **Expected: the "blocked on a dialog" panel, the
   command is NOT approved, and `/clear` did NOT run.** This is the security fix;
   verify it by eye, not by test.
6. Leave the dialog open and wait ~15s without touching anything. **Expected: an
   unprompted watchdog alert in that session's topic.** Wait another 15s:
   **expected: no second alert.**
7. Answer the dialog with the panel's `1`. Confirm Claude proceeds.

## Self-review notes

- Spec coverage: `exec.ts` (Task 1), `modal-detect.ts` (Task 2), `keys.ts` (Task 3),
  `/peek` panel + `tui:*` (Task 4), send guard + blocked render (Task 5),
  watchdog (Task 6). Divergences (no epoch, pane-id targeting) are implemented in
  Tasks 3 and 4. Error-handling table rows map to: empty capture (Tasks 1, 2, 5),
  session gone (Task 4), not-modified (Task 4, via the existing `.catch(() => {})`
  on `editMessageText`), send-keys failure (Task 4), watchdog throw (Task 6),
  concurrent taps (Task 4), authorization (Task 4).
- Naming is consistent across tasks: `capturePane`, `tmuxBase`, `runTmux`,
  `isModalPresent`, `claudeInputBarContent`, `promptVisibleInPane`, `tuiKeyArgv`,
  `buildTuiKeyboard`, `parseTuiCallback`, `planTuiTap`, `planGuardedSend`,
  `planModalAlerts`, `replyBlockedPanel`.
- Every external symbol the plan references was checked against the tree while
  planning. One guess was wrong and is now corrected: there is no
  `TELEGRAM_CHAT_ID` in `src/config.ts`, so Task 6 adds a `getChatId()` accessor
  to `src/topics/topic-store.ts` (where `chatId` actually lives) rather than
  leaving the implementer to guess.
- `buildTmuxSendArgs` is superseded by `runTmuxSend` in Task 5. Grep for callers
  before deleting it; `src/__tests__/` may reference it.
