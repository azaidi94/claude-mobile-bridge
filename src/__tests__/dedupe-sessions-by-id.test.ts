import { describe, test, expect } from "bun:test";
import { dedupeSessionsById } from "../sessions/watcher";
import type { SessionInfo } from "../sessions/types";

const si = (
  id: string,
  dir: string,
  extra: Partial<SessionInfo> = {},
): SessionInfo => ({
  id,
  name: "",
  dir,
  lastActivity: 0,
  source: "desktop",
  ...extra,
});

describe("dedupeSessionsById (moved-cwd port file vs JSONL)", () => {
  test("keeps the entry whose dir has a live process, drops the stale port-file dir", () => {
    // Port file still says my_repo (written at launch); Claude resumed a
    // transcript whose cwd is my_repo/acme-api, so the process lives there.
    const stale = si("sess-1", "/p/my_repo");
    const live = si("sess-1", "/p/my_repo/acme-api");
    const out = dedupeSessionsById(
      [stale, live],
      new Map([["/p/my_repo/acme-api", 1]]),
    );
    expect(out).toEqual([live]);
  });

  test("order of discovery does not matter", () => {
    const stale = si("sess-1", "/p/my_repo");
    const live = si("sess-1", "/p/my_repo/acme-api");
    const a = dedupeSessionsById(
      [stale, live],
      new Map([["/p/my_repo/acme-api", 1]]),
    );
    const b = dedupeSessionsById(
      [live, stale],
      new Map([["/p/my_repo/acme-api", 1]]),
    );
    expect(a).toEqual(b);
    expect(a[0]?.dir).toBe("/p/my_repo/acme-api");
  });

  test("both dirs live (sibling in launch dir): the owning process's cwd wins, in either order", () => {
    // A sibling Claude still runs in my_repo, and the relay's own Claude
    // (port-file ppid) has moved to acme-api. Scan order must not matter.
    const stale = si("sess-1", "/p/my_repo");
    const live = si("sess-1", "/p/my_repo/acme-api");
    const running = new Map([
      ["/p/my_repo", 1],
      ["/p/my_repo/acme-api", 1],
    ]);
    const cwdById = new Map([["sess-1", "/p/my_repo/acme-api"]]);
    expect(dedupeSessionsById([stale, live], running, cwdById)).toEqual([live]);
    expect(dedupeSessionsById([live, stale], running, cwdById)).toEqual([live]);
  });

  test("with no live-process tiebreak, keeps the first and drops the rest", () => {
    const first = si("sess-1", "/p/a");
    const second = si("sess-1", "/p/b");
    expect(dedupeSessionsById([first, second], new Map())).toEqual([first]);
  });

  test("entries without an id are never merged", () => {
    const x = si("", "/p/a");
    const y = si("", "/p/b");
    expect(dedupeSessionsById([x, y], new Map())).toEqual([x, y]);
  });

  test("distinct ids in the same dir are untouched (siblings)", () => {
    const x = si("sess-1", "/p/a");
    const y = si("sess-2", "/p/a");
    expect(dedupeSessionsById([x, y], new Map([["/p/a", 2]]))).toEqual([x, y]);
  });
});
