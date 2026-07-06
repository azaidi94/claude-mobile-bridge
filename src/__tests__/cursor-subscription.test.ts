// src/__tests__/cursor-subscription.test.ts
import { describe, it, expect } from "bun:test";
import {
  getCursorSubscription,
  setCursorSubscription,
  isCursorBridgeRunning,
} from "../cursor";

describe("cursor subscription state", () => {
  it("defaults to no subscription and not running", () => {
    expect(getCursorSubscription()).toBeNull();
    expect(isCursorBridgeRunning()).toBe(false);
  });

  it("tracks a single subscription, replacing the previous one", () => {
    // No bridge started (telegramForward undefined), so setCursorSubscription
    // only mutates the tracked name — no cross-post wiring to mock.
    setCursorSubscription("cursor-foo");
    expect(getCursorSubscription()).toBe("cursor-foo");

    setCursorSubscription("cursor-bar");
    expect(getCursorSubscription()).toBe("cursor-bar");

    setCursorSubscription(null);
    expect(getCursorSubscription()).toBeNull();
  });
});
