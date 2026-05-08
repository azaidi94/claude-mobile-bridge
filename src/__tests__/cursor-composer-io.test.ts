import { describe, it, expect } from "bun:test";
import {
  buildObserverScript,
  buildInjectScript,
  parseSnapshotResult,
} from "../cursor/composer-io";

describe("buildObserverScript", () => {
  it("includes both binding names in the script", () => {
    const script = buildObserverScript({
      human: "humanBinding",
      ai: "aiBinding",
    });
    expect(script).toContain("humanBinding");
    expect(script).toContain("aiBinding");
    expect(script).toContain("MutationObserver");
    expect(script).toContain("querySelectorAll");
  });

  it("uses different binding names when specified", () => {
    const script = buildObserverScript({ human: "alpha", ai: "beta" });
    expect(script).toContain("alpha");
    expect(script).toContain("beta");
  });

  it("includes selectors for both human and ai message bubbles", () => {
    const script = buildObserverScript({ human: "h", ai: "a" });
    expect(script).toContain('data-message-role=\\"human\\"');
    expect(script).toContain('data-message-role=\\"ai\\"');
    expect(script).toContain(".markdown-root");
    expect(script).toContain(".composer-human-message-content");
  });
});

describe("buildInjectScript", () => {
  it("includes the message text", () => {
    const script = buildInjectScript("hello world");
    expect(script).toContain('"hello world"');
    // Lexical contenteditable path — paste event with DataTransfer.
    expect(script).toContain("ClipboardEvent");
    expect(script).toContain("dispatchEvent");
  });

  it("escapes single quotes safely via JSON.stringify", () => {
    const script = buildInjectScript("it's a test");
    // JSON.stringify produces "it's a test" (single quotes don't need escaping in JSON)
    expect(script).toContain(`"it's a test"`);
  });

  it("escapes backslashes safely via JSON.stringify", () => {
    const script = buildInjectScript("path\\to\\file");
    // JSON.stringify of "path\to\file" produces "path\\to\\file"
    expect(script).toContain(`"path\\\\to\\\\file"`);
  });

  it("escapes newlines safely via JSON.stringify", () => {
    const script = buildInjectScript("hello\nworld");
    // JSON.stringify produces "hello\nworld" (escaped \n not a literal newline)
    expect(script).toContain('"hello\\nworld"');
    // Must NOT contain a literal newline inside the string literal
    expect(script).not.toMatch(/"hello\nworld"/);
  });

  it("clears the Composer before pasting on contenteditable path", () => {
    // Otherwise the new injection appends to whatever was already in
    // the input (probe leftovers, draft text), and Cursor submits the
    // concatenated mess.
    const script = buildInjectScript("fresh content");
    expect(script).toContain("selectAll");
    expect(script).toContain("delete");
    // selectAll + delete must come before the paste dispatch so the
    // input is empty when the new text arrives.
    const idxClear = script.indexOf("selectAll");
    const idxPaste = script.indexOf("ClipboardEvent");
    expect(idxClear).toBeGreaterThan(0);
    expect(idxPaste).toBeGreaterThan(idxClear);
  });
});

describe("parseSnapshotResult", () => {
  it("returns string array from CDP result", () => {
    const result = parseSnapshotResult({
      result: { type: "object", value: ["Hello", "World"] },
    });
    expect(result).toEqual(["Hello", "World"]);
  });

  it("returns empty array for non-array or missing value", () => {
    expect(parseSnapshotResult({ result: { type: "undefined" } })).toEqual([]);
    expect(parseSnapshotResult(null)).toEqual([]);
    expect(
      parseSnapshotResult({ result: { type: "object", value: null } }),
    ).toEqual([]);
  });
});
