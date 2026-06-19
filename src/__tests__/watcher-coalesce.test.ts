import "./ensure-test-env";
import { describe, test, expect, afterEach } from "bun:test";
import {
  forceRefresh,
  stopWatcher,
  _setDoRefreshForTest,
} from "../sessions/watcher";
import type { SessionDiff } from "../sessions/notifications";

const empty: SessionDiff = { added: [], removed: [] };

// Reset coalesce state + override between tests
afterEach(() => _setDoRefreshForTest(null));

describe("refresh() coalescing", () => {
  test("two concurrent forceRefresh calls produce exactly one scan invocation", async () => {
    let scanCount = 0;
    let resolve!: (v: SessionDiff) => void;
    const scanPromise = new Promise<SessionDiff>((r) => {
      resolve = r;
    });

    _setDoRefreshForTest(() => {
      scanCount++;
      return scanPromise;
    });

    // Start two concurrent refreshes before the first scan resolves
    const p1 = forceRefresh();
    const p2 = forceRefresh();

    // Neither has resolved yet — scanCount should be 1 (coalesced)
    expect(scanCount).toBe(1);

    resolve(empty);
    await Promise.all([p1, p2]);

    expect(scanCount).toBe(1); // still one: second caller coalesced onto in-flight
  });

  test("a third call while first is running triggers exactly one follow-up", async () => {
    let scanCount = 0;
    const resolvers: Array<(v: SessionDiff) => void> = [];

    _setDoRefreshForTest(() => {
      scanCount++;
      return new Promise<SessionDiff>((r) => resolvers.push(r));
    });

    const p1 = forceRefresh();
    const p2 = forceRefresh(); // sets dirty flag
    const p3 = forceRefresh(); // also sets dirty flag (idempotent)

    expect(scanCount).toBe(1);
    resolvers[0]!(empty);
    await Promise.all([p1, p2, p3]);

    // dirty flag triggers exactly one follow-up
    await new Promise((r) => setTimeout(r, 0)); // let follow-up run
    expect(resolvers.length).toBe(2); // original + one follow-up was queued
    resolvers[1]!(empty);
    await new Promise((r) => setTimeout(r, 10));
    expect(scanCount).toBe(2); // original + exactly one follow-up
  });

  test("stopWatcher cancels a scheduled follow-up scan", async () => {
    let scanCount = 0;
    const resolvers: Array<(v: SessionDiff) => void> = [];

    _setDoRefreshForTest(() => {
      scanCount++;
      return new Promise<SessionDiff>((r) => resolvers.push(r));
    });

    const p1 = forceRefresh();
    const p2 = forceRefresh(); // sets dirty → follow-up scheduled on completion
    resolvers[0]!(empty);
    await Promise.all([p1, p2]);

    // Follow-up timer is now pending; stopping the watcher must cancel it so
    // no scan mutates the session cache after stop.
    stopWatcher();
    await new Promise((r) => setTimeout(r, 10));
    expect(scanCount).toBe(1);
  });

  test("sequential calls each run a fresh scan", async () => {
    let scanCount = 0;
    _setDoRefreshForTest(async () => {
      scanCount++;
      return empty;
    });

    await forceRefresh();
    await forceRefresh();

    expect(scanCount).toBe(2);
  });
});
