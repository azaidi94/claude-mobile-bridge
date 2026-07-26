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
