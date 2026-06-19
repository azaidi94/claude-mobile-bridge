/**
 * Tests for the relay→tailer turn-claim key. The key must distinguish
 * replies that share a long common prefix — consecutive structured replies
 * often start with an identical header, and a collision makes the tailer
 * silently suppress the second reply.
 */

import "./ensure-test-env";
import { describe, expect, test } from "bun:test";
import {
  turnClaimKey,
  claimTurn,
  checkAndConsumeClaim,
} from "../handlers/watch/turn-claims";

describe("turnClaimKey", () => {
  test("same content yields a stable key", () => {
    const content = "y".repeat(200) + " tail";
    expect(turnClaimKey(content)).toBe(turnClaimKey(content));
  });

  test("replies sharing a 128-char prefix get distinct keys", () => {
    const prefix = "x".repeat(128);
    expect(turnClaimKey(prefix + " first reply")).not.toBe(
      turnClaimKey(prefix + " second reply"),
    );
  });

  test("same-length replies sharing a 128-char prefix get distinct keys", () => {
    const prefix = "x".repeat(128);
    expect(turnClaimKey(prefix + "AAA")).not.toBe(turnClaimKey(prefix + "BBB"));
  });

  test("claim and consume round-trip through the key", () => {
    const claims = new Map<string, number>();
    const content = "z".repeat(300);
    claimTurn(claims, turnClaimKey(content));
    expect(checkAndConsumeClaim(claims, turnClaimKey(content))).toBe(true);
    // Consumed — second check is a miss.
    expect(checkAndConsumeClaim(claims, turnClaimKey(content))).toBe(false);
  });
});
