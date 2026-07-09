import { test, expect } from "bun:test";
import { parseVerboseLevel } from "../handlers/commands/verbose";

test("parseVerboseLevel accepts numeric levels and word aliases", () => {
  expect(parseVerboseLevel("0")).toBe(0);
  expect(parseVerboseLevel("1")).toBe(1);
  expect(parseVerboseLevel("2")).toBe(2);
  expect(parseVerboseLevel(" quiet ")).toBe(0);
  expect(parseVerboseLevel("normal")).toBe(1);
  expect(parseVerboseLevel("detailed")).toBe(2);
});

test("parseVerboseLevel rejects invalid input", () => {
  expect(parseVerboseLevel("3")).toBeNull();
  expect(parseVerboseLevel("")).toBeNull();
  expect(parseVerboseLevel("loud")).toBeNull();
});
