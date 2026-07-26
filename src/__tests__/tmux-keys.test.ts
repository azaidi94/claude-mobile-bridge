import { test, expect, describe } from "bun:test";
import {
  TUI_ACTIONS,
  tuiKeyArgv,
  buildTuiKeyboard,
  parseTuiCallback,
} from "../tmux/keys";

const UUID = "01234567-89ab-cdef-0123-456789abcdef"; // 36 chars

describe("tuiKeyArgv", () => {
  test("maps every key action to tmux argv", () => {
    expect(tuiKeyArgv("up")).toEqual(["Up"]);
    expect(tuiKeyArgv("dn")).toEqual(["Down"]);
    expect(tuiKeyArgv("lt")).toEqual(["Left"]);
    expect(tuiKeyArgv("rt")).toEqual(["Right"]);
    expect(tuiKeyArgv("ent")).toEqual(["Enter"]);
    expect(tuiKeyArgv("bsp")).toEqual(["BSpace"]);
    expect(tuiKeyArgv("esc")).toEqual(["Escape"]);
    expect(tuiKeyArgv("tab")).toEqual(["Tab"]);
    expect(tuiKeyArgv("btab")).toEqual(["BTab"]);
    expect(tuiKeyArgv("cC")).toEqual(["C-c"]);
    expect(tuiKeyArgv("cU")).toEqual(["C-u"]);
    expect(tuiKeyArgv("cO")).toEqual(["C-o"]);
    expect(tuiKeyArgv("cR")).toEqual(["C-r"]);
    expect(tuiKeyArgv("cT")).toEqual(["C-t"]);
    expect(tuiKeyArgv("num0")).toEqual(["0"]);
    expect(tuiKeyArgv("num1")).toEqual(["1"]);
    expect(tuiKeyArgv("num2")).toEqual(["2"]);
    expect(tuiKeyArgv("num3")).toEqual(["3"]);
  });

  test("esc2 sends two Escapes", () => {
    expect(tuiKeyArgv("esc2")).toEqual(["Escape", "Escape"]);
  });

  test("refresh and close send no keys", () => {
    expect(tuiKeyArgv("refresh")).toEqual([]);
    expect(tuiKeyArgv("close")).toEqual([]);
  });

  test("an unknown action returns null — never reaches send-keys", () => {
    expect(tuiKeyArgv("rm -rf /")).toBeNull();
    expect(tuiKeyArgv("")).toBeNull();
    expect(tuiKeyArgv("Enter")).toBeNull(); // raw tmux key names are not actions
  });

  test("there are exactly 21 actions", () => {
    expect(TUI_ACTIONS.length).toBe(21);
  });
});

describe("parseTuiCallback", () => {
  test("round-trips every action through the keyboard", () => {
    const kb = buildTuiKeyboard(UUID);
    const datas = kb.inline_keyboard
      .flat()
      .map((b) => (b as { callback_data: string }).callback_data);
    expect(datas.length).toBe(21);
    for (const d of datas) {
      const parsed = parseTuiCallback(d);
      expect(parsed).not.toBeNull();
      expect(parsed!.launchUuid).toBe(UUID);
      expect(TUI_ACTIONS).toContain(parsed!.action);
    }
  });

  test("callback data fits Telegram's 64-byte limit", () => {
    for (const row of buildTuiKeyboard(UUID).inline_keyboard) {
      for (const btn of row) {
        const d = (btn as { callback_data: string }).callback_data;
        expect(Buffer.byteLength(d, "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });

  test("rejects a wrong prefix, unknown action, or missing uuid", () => {
    expect(parseTuiCallback(`tmux:up:${UUID}`)).toBeNull();
    expect(parseTuiCallback(`tui:bogus:${UUID}`)).toBeNull();
    expect(parseTuiCallback("tui:up:")).toBeNull();
    expect(parseTuiCallback("tui:up")).toBeNull();
  });

  test("keyboard has the 4-row layout", () => {
    const kb = buildTuiKeyboard(UUID);
    expect(kb.inline_keyboard.map((r) => r.length)).toEqual([4, 6, 4, 7]);
  });
});
