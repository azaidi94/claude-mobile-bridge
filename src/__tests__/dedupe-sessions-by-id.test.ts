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
    // Port file still says kx_repo (written at launch); Claude resumed a
    // transcript whose cwd is kx_repo/kinetix-agents, so the process lives there.
    const stale = si("sess-1", "/p/kx_repo");
    const live = si("sess-1", "/p/kx_repo/kinetix-agents");
    const out = dedupeSessionsById(
      [stale, live],
      new Map([["/p/kx_repo/kinetix-agents", 1]]),
    );
    expect(out).toEqual([live]);
  });

  test("order of discovery does not matter", () => {
    const stale = si("sess-1", "/p/kx_repo");
    const live = si("sess-1", "/p/kx_repo/kinetix-agents");
    const a = dedupeSessionsById(
      [stale, live],
      new Map([["/p/kx_repo/kinetix-agents", 1]]),
    );
    const b = dedupeSessionsById(
      [live, stale],
      new Map([["/p/kx_repo/kinetix-agents", 1]]),
    );
    expect(a).toEqual(b);
    expect(a[0]?.dir).toBe("/p/kx_repo/kinetix-agents");
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
