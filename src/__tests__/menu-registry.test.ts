import { describe, test, expect, beforeEach } from "bun:test";
import {
  putToken,
  getToken,
  MENU_TOKEN_TTL_MS,
  _resetMenuRegistryForTests,
} from "../menus/registry";

describe("menu token registry", () => {
  beforeEach(() => _resetMenuRegistryForTests());

  test("round-trips a payload", () => {
    const t = putToken({ kind: "k", payload: { dir: "/p" }, chatId: 1 });
    expect(t).toMatch(/^[a-z0-9]{8}$/);
    expect(getToken(t)).toMatchObject({
      kind: "k",
      payload: { dir: "/p" },
      chatId: 1,
    });
  });

  test("expires after the TTL", () => {
    const t = putToken({ kind: "k", payload: null, chatId: 1 }, 1000);
    expect(getToken(t, 1000 + MENU_TOKEN_TTL_MS)).toBeDefined();
    expect(getToken(t, 1001 + MENU_TOKEN_TTL_MS)).toBeUndefined();
    expect(getToken(t, 1000)).toBeUndefined(); // dropped once seen expired
  });

  test("unknown tokens resolve to nothing", () => {
    expect(getToken("nope")).toBeUndefined();
    expect(getToken("")).toBeUndefined();
  });

  test("tokens are unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++)
      seen.add(putToken({ kind: "k", payload: i, chatId: 1 }));
    expect(seen.size).toBe(1000);
  });

  test("reset clears everything", () => {
    const t = putToken({ kind: "k", payload: null, chatId: 1 });
    _resetMenuRegistryForTests();
    expect(getToken(t)).toBeUndefined();
  });
});
