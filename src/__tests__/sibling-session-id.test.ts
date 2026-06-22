/**
 * Sibling-session id resolution. When two relays share a directory, a port
 * file that lacks an explicit sessionId must NOT be back-filled with a guessed
 * JSONL id — the guess routinely grabs the sibling's transcript id, and since
 * relay selection matches sessionId before pid, that misroutes messages to the
 * wrong session. With 2+ siblings we leave the id empty and rely on exact pid
 * (ppid) matching instead.
 */

import "./ensure-test-env";
import { describe, expect, test } from "bun:test";
import { resolveSiblingId } from "../sessions/watcher";

describe("resolveSiblingId", () => {
  test("keeps an explicit port-file sessionId", () => {
    const next = () => "fallback-id";
    expect(resolveSiblingId("real-id", 2, next)).toBe("real-id");
  });

  test("lone relay back-fills from the JSONL fallback", () => {
    const next = () => "fallback-id";
    expect(resolveSiblingId(undefined, 1, next)).toBe("fallback-id");
  });

  test("lone relay with no fallback resolves empty", () => {
    const next = () => undefined;
    expect(resolveSiblingId(undefined, 1, next)).toBe("");
  });

  test("sibling relay (2+) NEVER guesses — resolves empty so pid routes it", () => {
    let called = false;
    const next = () => {
      called = true;
      return "siblings-id";
    };
    expect(resolveSiblingId(undefined, 2, next)).toBe("");
    // Must not even consult the fallback — guessing is the misroute bug.
    expect(called).toBe(false);
  });
});
