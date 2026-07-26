import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { planModalAlerts } from "../tmux/watchdog";

const FIXTURES = join(import.meta.dir, "fixtures", "tmux-panes");
const pane = (n: string): string =>
  readFileSync(join(FIXTURES, `${n}.txt`), "utf8");

const MODAL = pane("bash-permission");
const IDLE = pane("idle-bar");

const rows = (...uuids: string[]) =>
  uuids.map((launchUuid) => ({ launchUuid, pane: "%1" }));

describe("planModalAlerts", () => {
  test("alerts once on a modal pane", () => {
    const { alerts, nextMap } = planModalAlerts(
      rows("a"),
      () => MODAL,
      new Map(),
    );
    expect(alerts.map((a) => a.launchUuid)).toEqual(["a"]);
    expect(nextMap.get("a")).toBe(MODAL);
  });

  test("does not re-alert on an unchanged pane", () => {
    const first = planModalAlerts(rows("a"), () => MODAL, new Map());
    const second = planModalAlerts(rows("a"), () => MODAL, first.nextMap);
    expect(second.alerts).toEqual([]);
  });

  test("clears state at idle, then re-alerts on a NEW modal", () => {
    const first = planModalAlerts(rows("a"), () => MODAL, new Map());
    const idle = planModalAlerts(rows("a"), () => IDLE, first.nextMap);
    expect(idle.alerts).toEqual([]);
    expect(idle.nextMap.has("a")).toBe(false);
    const again = planModalAlerts(rows("a"), () => MODAL, idle.nextMap);
    expect(again.alerts.map((a) => a.launchUuid)).toEqual(["a"]);
  });

  test("never alerts on an unreadable pane", () => {
    const { alerts } = planModalAlerts(rows("a"), () => "", new Map());
    expect(alerts).toEqual([]);
  });

  test("a row without a launchUuid is skipped", () => {
    const { alerts } = planModalAlerts(
      [{ launchUuid: undefined, pane: "%1" }],
      () => MODAL,
      new Map(),
    );
    expect(alerts).toEqual([]);
  });

  test("one throwing row does not stop the others", () => {
    const capture = (p: string): string => {
      if (p === "%boom") throw new Error("tmux exploded");
      return MODAL;
    };
    const input = [
      { launchUuid: "a", pane: "%boom" },
      { launchUuid: "b", pane: "%2" },
    ];
    const { alerts } = planModalAlerts(input, capture, new Map());
    expect(alerts.map((a) => a.launchUuid)).toEqual(["b"]);
  });
});
