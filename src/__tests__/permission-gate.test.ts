/**
 * The relay-side gate between an inbound socket frame and an actual tool
 * approval. `accept()` returning a behavior is what causes a shell command to
 * run, so these tests pin the cases where it must refuse.
 */

import "./ensure-test-env";
import { describe, expect, test } from "bun:test";
import { PermissionGate } from "../mcp/channel-relay/permission-gate";

describe("PermissionGate", () => {
  test("accepts a forwarded id", () => {
    const g = new PermissionGate();
    g.forward("cmssh");
    expect(g.accept("cmssh", "allow")).toBe("allow");
  });

  test("refuses an id we never forwarded", () => {
    // Any frame that reaches the local socket would otherwise become an
    // approval for a prompt we never showed anyone.
    const g = new PermissionGate();
    expect(g.accept("cmssh", "allow")).toBeNull();
  });

  test("refuses anything that isn't exactly allow or deny", () => {
    const g = new PermissionGate();
    for (const b of [
      "yes",
      "ALLOW",
      "Allow",
      "",
      "1",
      true,
      null,
      undefined,
      {},
    ]) {
      g.forward("cmssh");
      expect(g.accept("cmssh", b)).toBeNull();
    }
    // ...and a truthiness-based refactor would break this one:
    g.forward("cmssh");
    expect(g.accept("cmssh", "deny")).toBe("deny");
  });

  test("refuses an empty id", () => {
    const g = new PermissionGate();
    g.forward("");
    expect(g.accept("", "allow")).toBeNull();
  });

  test("consumes the id — a replayed frame is dropped", () => {
    const g = new PermissionGate();
    g.forward("cmssh");
    expect(g.accept("cmssh", "allow")).toBe("allow");
    expect(g.accept("cmssh", "deny")).toBeNull();
  });

  test("a rejected behavior does not consume the id", () => {
    // Otherwise one malformed frame would disarm the real answer that follows.
    const g = new PermissionGate();
    g.forward("cmssh");
    expect(g.accept("cmssh", "maybe")).toBeNull();
    expect(g.accept("cmssh", "allow")).toBe("allow");
  });

  test("ids are independent", () => {
    const g = new PermissionGate();
    g.forward("aaaaa");
    g.forward("bbbbb");
    expect(g.accept("aaaaa", "allow")).toBe("allow");
    expect(g.accept("bbbbb", "deny")).toBe("deny");
  });

  test("eviction bounds memory and drops the oldest first", () => {
    const g = new PermissionGate(3);
    g.forward("a");
    g.forward("b");
    g.forward("c");
    g.forward("d"); // evicts "a"
    expect(g.size).toBe(3);
    expect(g.accept("a", "allow")).toBeNull();
    expect(g.accept("d", "allow")).toBe("allow");
    expect(g.accept("b", "allow")).toBe("allow");
  });

  test("re-forwarding an id keeps it acceptable", () => {
    const g = new PermissionGate(2);
    g.forward("a");
    g.forward("a");
    expect(g.accept("a", "allow")).toBe("allow");
  });
});
