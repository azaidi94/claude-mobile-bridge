import { describe, test, expect, beforeEach } from "bun:test";
import {
  markRelayInflight,
  isRelayInflight,
  _resetInflightRelayForTests,
} from "../handlers/watch/inflight-relay";

beforeEach(() => {
  _resetInflightRelayForTests();
});

describe("inflight-relay", () => {
  test("a session is not in-flight by default", () => {
    expect(isRelayInflight("S")).toBe(false);
  });

  test("marking makes it in-flight until unmarked", () => {
    const unmark = markRelayInflight("S");
    expect(isRelayInflight("S")).toBe(true);
    unmark();
    expect(isRelayInflight("S")).toBe(false);
  });

  test("ref-counts overlapping requests for the same session", () => {
    const unmarkA = markRelayInflight("S");
    const unmarkB = markRelayInflight("S");
    unmarkA();
    expect(isRelayInflight("S")).toBe(true);
    unmarkB();
    expect(isRelayInflight("S")).toBe(false);
  });

  test("unmark is idempotent (double-call does not underflow)", () => {
    const unmark = markRelayInflight("S");
    unmark();
    unmark();
    expect(isRelayInflight("S")).toBe(false);
    // A fresh mark for the same session still works after a double-unmark.
    const unmark2 = markRelayInflight("S");
    expect(isRelayInflight("S")).toBe(true);
    unmark2();
    expect(isRelayInflight("S")).toBe(false);
  });

  test("sessions are tracked independently", () => {
    const unmark = markRelayInflight("S");
    expect(isRelayInflight("S")).toBe(true);
    expect(isRelayInflight("OTHER")).toBe(false);
    unmark();
  });
});
