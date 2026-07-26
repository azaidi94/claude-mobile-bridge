/**
 * The send guard: Enter must never land in a Claude Code modal.
 *
 * Two layers, both required. `planGuardedSend` is the pure decision; the
 * `sendKeysToTmux` block asserts the decision is actually WIRED — that no
 * `Enter` argv leaves the process against a modal pane, and that one does on a
 * real delivery. Without the positive case a constant-false guard would pass.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planGuardedSend,
  sendKeysToTmux,
  type TmuxSendIO,
} from "../handlers/commands/terminal-inject";
import type { TmuxTarget } from "../tmux/exec";

const FIXTURES = join(import.meta.dir, "fixtures", "tmux-panes");
const pane = (n: string): string =>
  readFileSync(join(FIXTURES, `${n}.txt`), "utf8");

/** Every captured pane in which Claude is blocked on a dialog. */
const MODALS = [
  "bash-permission",
  "trust-dialog",
  "model-picker",
  "chrome-modal",
  "usage",
];

/**
 * `usage` blocks input like the other MODALS fixtures, but — unlike them —
 * carries no capital-E "Esc to ..." / "Enter to confirm" footer token, so
 * `isModalPresent` doesn't detect it. It still gets a `blocked:true` refusal,
 * just with an honest "not accepting input" reason instead of "blocked on a
 * dialog". Keep it out of MODALS-with-dialog-footer assertions below.
 */
const MODALS_WITH_FOOTER = MODALS.filter((m) => m !== "usage");

const TARGET: TmuxTarget = { pane: "%3", socket: "/tmp/s" };

describe("planGuardedSend", () => {
  test("NEVER sends Enter when the after-pane is a modal", () => {
    for (const modal of MODALS) {
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

/** Records every send-keys batch, replaying `captures` in order. */
function recordingIO(captures: string[]): {
  io: TmuxSendIO;
  sent: string[][];
} {
  const sent: string[][] = [];
  let n = 0;
  return {
    sent,
    io: {
      settleMs: 0,
      capture: () => captures[n++] ?? "",
      send: (_t, keys) => {
        sent.push(keys);
        return { ok: true, stderr: "" };
      },
    },
  };
}

const enterSent = (sent: string[][]): boolean =>
  sent.some((keys) => keys.includes("Enter"));

describe("sendKeysToTmux", () => {
  test("emits NO Enter argv for any modal pane with a dialog footer", async () => {
    for (const modal of MODALS_WITH_FOOTER) {
      const { io, sent } = recordingIO([pane("idle-bar"), pane(modal)]);
      const r = await sendKeysToTmux(TARGET, "/clear", "uuid-1", io);

      expect(enterSent(sent)).toBe(false);
      expect(sent).toEqual([["-l", "/clear"]]);
      expect(r).toEqual({
        ok: false,
        app: "tmux",
        blocked: true,
        pane: pane(modal),
        launchUuid: "uuid-1",
        // The headline must ASSERT a dialog only when one was detected. See the
        // /usage test below for the other branch.
        blockedHeadline: "Session is blocked on a dialog.",
        reason: "the session is blocked on a dialog, so nothing was sent",
      });
    }
  });

  test("emits NO Enter argv for every MODALS fixture (footer or not)", async () => {
    // Broader guarantee than the footer-specific test above: regardless of how
    // the refusal is worded, Enter must never be sent for ANY fixture in which
    // Claude is blocked on a dialog — including `usage`, which has no footer
    // token `isModalPresent` can key off.
    for (const modal of MODALS) {
      const { io, sent } = recordingIO([pane("idle-bar"), pane(modal)]);
      const r = await sendKeysToTmux(TARGET, "/clear", "uuid-1", io);

      expect(enterSent(sent)).toBe(false);
      expect(r.ok).toBe(false);
    }
  });

  test("blocked:true with an honest 'not accepting input' reason when no dialog footer is detectable (/usage)", async () => {
    const { io, sent } = recordingIO([pane("idle-bar"), pane("usage")]);
    const r = await sendKeysToTmux(TARGET, "/clear", "uuid-1", io);

    expect(enterSent(sent)).toBe(false);
    expect(r).toEqual({
      ok: false,
      app: "tmux",
      blocked: true,
      pane: pane("usage"),
      launchUuid: "uuid-1",
      // MUST NOT claim a dialog exists: /usage blocks input with no footer token,
      // so none was detected. Telling the user to answer a dialog would send them
      // hunting for something that isn't there.
      blockedHeadline: "Session isn't accepting input (no dialog detected).",
      reason:
        "the session isn't accepting input (nothing was sent) — here's its screen",
    });
    expect(r.ok === false && r.blockedHeadline).not.toContain("dialog.");
  });

  test("emits NO Enter argv when the re-capture failed (unknown state), and does NOT claim 'blocked'", async () => {
    const { io, sent } = recordingIO([pane("idle-bar"), ""]);
    const r = await sendKeysToTmux(TARGET, "/clear", "uuid-1", io);

    expect(enterSent(sent)).toBe(false);
    expect(r).toEqual({
      ok: false,
      app: "tmux",
      reason:
        "couldn't read the session's screen (tmux not responding), so nothing was sent",
    });
    // Must not be reported as a dialog block: `blocked` and `pane` are unset,
    // since we genuinely don't know what's on screen.
    expect(r.ok === false && r.blocked).toBeUndefined();
    expect(r.ok === false && r.pane).toBeUndefined();
  });

  test("emits Enter when the text demonstrably landed in the bar", async () => {
    const { io, sent } = recordingIO([
      pane("idle-bar"),
      pane("idle-bar-typed"),
    ]);
    const r = await sendKeysToTmux(
      TARGET,
      "hello world this is a test",
      "uuid-1",
      io,
    );

    expect(sent).toEqual([["-l", "hello world this is a test"], ["Enter"]]);
    expect(r).toEqual({
      ok: true,
      app: "tmux",
      note: "sent to tmux pane %3",
    });
  });

  test("never re-captures nor presses Enter when the literal send failed", async () => {
    const sent: string[][] = [];
    const io: TmuxSendIO = {
      settleMs: 0,
      capture: () => pane("idle-bar"),
      send: (_t, keys) => {
        sent.push(keys);
        return { ok: false, stderr: "can't find pane" };
      },
    };
    const r = await sendKeysToTmux(TARGET, "/clear", undefined, io);

    expect(enterSent(sent)).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("can't find pane");
  });
});
