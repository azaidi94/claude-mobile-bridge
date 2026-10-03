import { describe, test, expect } from "bun:test";
import { parseNewArgs } from "../handlers/commands/new-args";

const ID = "62d0fa2e-bee6-4068-96fe-b41c96d6ce18";

describe("parseNewArgs", () => {
  test("bare", () => expect(parseNewArgs("/new")).toEqual({ branch: false }));
  test("path", () =>
    expect(parseNewArgs("/new ~/p/x")).toEqual({
      branch: false,
      path: "~/p/x",
    }));
  test("path with spaces", () =>
    expect(parseNewArgs("/new ~/p/my dir")).toEqual({
      branch: false,
      path: "~/p/my dir",
    }));
  test("--branch", () =>
    expect(parseNewArgs("/new --branch")).toEqual({ branch: true }));
  test("-b alias", () =>
    expect(parseNewArgs("/new -b")).toEqual({ branch: true }));
  test("--resume id path", () =>
    expect(parseNewArgs(`/new --resume ${ID} ~/p`)).toEqual({
      branch: false,
      resume: ID,
      path: "~/p",
    }));
  test("-r alias", () =>
    expect(parseNewArgs(`/new -r ${ID}`)).toEqual({
      branch: false,
      resume: ID,
    }));
  test("id is lower-cased", () =>
    expect(parseNewArgs(`/new -r ${ID.toUpperCase()}`).resume).toBe(ID));
  test("--resume without id", () =>
    expect(parseNewArgs("/new --resume").error).toContain("session id"));
  test("--resume bad id", () =>
    expect(parseNewArgs("/new --resume nope").error).toContain("session id"));
  test("--branch with --resume", () =>
    expect(parseNewArgs(`/new --branch --resume ${ID}`).error).toContain(
      "either",
    ));
  test("unknown flag", () =>
    expect(parseNewArgs("/new --wat").error).toContain("--wat"));
  test("works with @botname suffix", () =>
    expect(parseNewArgs("/new@MyBot --branch")).toEqual({ branch: true }));
});
