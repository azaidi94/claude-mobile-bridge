import { test, expect, describe } from "bun:test";
import {
  planTuiTap,
  planConfirmTap,
  CONFIRM_WINDOW_MS,
} from "../handlers/commands/tmux";

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

describe("planConfirmTap", () => {
  const NOW = 1_000_000;

  test("a harmless key sends on the first tap", () => {
    expect(planConfirmTap("dn", undefined, NOW).send).toBe(true);
    expect(planConfirmTap("ent", undefined, NOW).send).toBe(true);
  });

  test("an unarmed ⌃C arms instead of interrupting", () => {
    const p = planConfirmTap("cC", undefined, NOW);
    expect(p.send).toBe(false);
    expect(p.notice).toContain("again");
  });

  test("a second ⌃C inside the window sends", () => {
    expect(planConfirmTap("cC", NOW, NOW + CONFIRM_WINDOW_MS - 1).send).toBe(
      true,
    );
  });

  test("a stale arm is not consent — it re-arms", () => {
    const p = planConfirmTap("cC", NOW, NOW + CONFIRM_WINDOW_MS + 1);
    expect(p.send).toBe(false);
  });

  test("an armed session's harmless keys are unaffected", () => {
    expect(planConfirmTap("up", NOW, NOW + 1).send).toBe(true);
  });
});
