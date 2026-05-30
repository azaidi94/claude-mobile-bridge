import { describe, it, expect } from "bun:test";
import { isUnloadedTitle } from "../cursor";

describe("isUnloadedTitle", () => {
  it("detects vscode-file:// transient titles", () => {
    expect(
      isUnloadedTitle(
        "vscode-file://vscode-app/Applications/Cursor.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html",
      ),
    ).toBe(true);
  });

  it("detects http(s) transient titles", () => {
    expect(isUnloadedTitle("https://example.com/x")).toBe(true);
    expect(isUnloadedTitle("http://localhost:3000")).toBe(true);
  });

  it("accepts a settled '<file> — <workspace>' title", () => {
    expect(isUnloadedTitle("2.1.132 — claude-mobile-bridge")).toBe(false);
    expect(isUnloadedTitle("index.ts — my-project")).toBe(false);
  });

  it("accepts a settled workspace-only title", () => {
    expect(isUnloadedTitle("claude-mobile-bridge")).toBe(false);
  });

  it("treats empty title as unloaded", () => {
    expect(isUnloadedTitle("")).toBe(true);
    expect(isUnloadedTitle("   ")).toBe(true);
  });
});
