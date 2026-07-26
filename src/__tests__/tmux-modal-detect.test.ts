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
 * Every state in which Enter must never be sent. Superset of MODALS: adds the two
 * pane-height captures and `/usage`, which Gate A cannot see but Gate B refuses.
 */
const NO_SEND_STATES = [...MODALS, "modal-tall", "modal-short", "usage"].filter(
  has,
);

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
    for (const name of NO_SEND_STATES) {
      const modal = pane(name);
      expect(promptVisibleInPane(pane("idle-bar"), modal, "/clear")).toBe(
        false,
      );
      // A prompt whose head collides with modal menu text must still be refused.
      expect(promptVisibleInPane(pane("idle-bar"), modal, "Yes")).toBe(false);
      expect(
        promptVisibleInPane(pane("idle-bar"), modal, "1. Yes, allow"),
      ).toBe(false);
      // Single chars are the highest-risk payload: `y` and `1` are what a menu
      // cursor would be sitting on. Anchoring must not make them matchable.
      expect(promptVisibleInPane(pane("idle-bar"), modal, "y")).toBe(false);
      expect(promptVisibleInPane(pane("idle-bar"), modal, "1")).toBe(false);
    }
  });

  test("all modal fixtures are exercised — else the loop above is vacuous", () => {
    expect(NO_SEND_STATES.length).toBe(7);
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

const SEP = "─".repeat(40);
const bar = (...lines: string[]): string =>
  [SEP, ...lines, SEP, "  ? for shortcuts"].join("\n");

describe("normalization and placeholders", () => {
  test("a prompt behind a [Pasted text #N] chip still reports delivery", () => {
    // Signal 1 anchors on position 0, so a chip preceding the echoed prompt
    // defeats it. Signal 2's placeholder count-delta is what covers this shape —
    // the ONLY prefix Claude renders inside the bar. Pinned so a change to
    // signal 2 cannot silently reintroduce a never-delivers bug.
    expect(
      promptVisibleInPane(
        bar("❯ "),
        bar("❯ [Pasted text #1] File: /very/long/path"),
        "File: /very/long/path",
      ),
    ).toBe(true);
  });

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
    // Anchoring, not a length floor, is what makes this false: "ok" is a
    // substring of the bar but not a prefix of it.
    expect(
      promptVisibleInPane(bar("❯ "), bar("❯ some unrelated ok text"), "ok"),
    ).toBe(false);
  });

  test("REGRESSION: short prompts report delivery — a length floor here would disable /clear", () => {
    // The bug this test exists for: signal 1 once required a 10-char head, so
    // promptVisibleInPane was hard-wired false for every prompt below 10 chars.
    // That is the entire payload set the tmux injection path was built to send —
    // the guard refused them forever, failing safe but silently dead.
    for (const short of ["/clear", "/compact", "/context", "y", "1"]) {
      expect(promptVisibleInPane(bar("❯ "), bar(`❯ ${short}`), short)).toBe(
        true,
      );
    }
  });

  test("a short prompt already in the bar is carry-over, not a new delivery", () => {
    const same = bar("❯ /clear");
    expect(promptVisibleInPane(same, same, "/clear")).toBe(false);
  });

  test("a ❯ menu cursor without a frame is not a bar", () => {
    expect(claudeInputBarContent("❯ 1. Yes\n  2. No\n")).toBeNull();
  });
});
