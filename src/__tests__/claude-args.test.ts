import { test, expect } from "bun:test";
import { sessionIdFromClaudeArgs } from "../utils/claude-args";

const ID = "7b46b3e4-0aee-40ca-b454-cf779721fd38";

test("--session-id, spaced or with =", () => {
  expect(sessionIdFromClaudeArgs(`claude --session-id ${ID} -p hi`)).toBe(ID);
  expect(sessionIdFromClaudeArgs(`claude --session-id=${ID}`)).toBe(ID);
});

// Regression: the desktop app passes `--resume=<id>`, which the old
// `--session-id\s+` regex never saw.
test("--resume pins its id, in the desktop app's = form too", () => {
  expect(
    sessionIdFromClaudeArgs(
      `/Users/a/Library/Application Support/Claude/claude-code/2.1.299/x/claude.app/Contents/MacOS/claude --output-format stream-json --resume=${ID} --allowedTools=x`,
    ),
  ).toBe(ID);
  expect(sessionIdFromClaudeArgs(`claude --resume ${ID}`)).toBe(ID);
});

test("--resume with --fork-session pins nothing", () => {
  expect(
    sessionIdFromClaudeArgs(`claude --resume ${ID} --fork-session`),
  ).toBeUndefined();
});

test("no id, or a non-uuid value", () => {
  expect(sessionIdFromClaudeArgs("claude --resume")).toBeUndefined();
  expect(sessionIdFromClaudeArgs("claude --session-id nope")).toBeUndefined();
  expect(sessionIdFromClaudeArgs("")).toBeUndefined();
});
