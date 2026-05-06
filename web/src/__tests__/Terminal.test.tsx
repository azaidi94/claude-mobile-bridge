import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { Terminal } from "../components/Terminal";
import type { SseEvent } from "../api";

describe("Terminal", () => {
  test("renders markdown bold inside text events as <strong>", () => {
    const events: SseEvent[] = [
      { type: "text", content: "hello **there**" },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.querySelector("strong")?.textContent).toBe("there");
  });

  test("renders HTML inside tool events without escaping", () => {
    const events: SseEvent[] = [
      { type: "tool", content: "<b>Read:</b> foo.txt" },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    const bold = container.querySelector("b");
    expect(bold?.textContent).toBe("Read:");
  });

  test("renders thinking HTML with italic class on parent", () => {
    const events: SseEvent[] = [
      { type: "thinking", content: "pondering <b>deeply</b>" },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.querySelector(".italic")).not.toBeNull();
    expect(container.querySelector("b")?.textContent).toBe("deeply");
  });

  test("skips done and segment_end events", () => {
    const events: SseEvent[] = [
      { type: "text", content: "shown" },
      { type: "done", content: "" },
      { type: "segment_end", content: "" },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.textContent).toContain("shown");
  });

  test("renders Edit tool as diff block with line numbers and - / + markers", () => {
    const events: SseEvent[] = [
      {
        type: "tool",
        content: "Editing file.ts",
        toolName: "Edit",
        toolInput: {
          file_path: "/src/foo/bar/file.ts",
          old_string: "const x = 1",
          new_string: "const x = 2",
        },
      },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.textContent).toContain("Edit(");
    expect(container.textContent).toContain("file.ts");
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("const x = 1");
    expect(pre!.textContent).toContain("const x = 2");
    // Has at least one removed and one added row
    expect(pre!.querySelectorAll(".bg-red-950\\/40").length).toBeGreaterThan(0);
    expect(pre!.querySelectorAll(".bg-green-950\\/40").length).toBeGreaterThan(0);
  });

  test("diff shows unchanged context lines between removals and additions", () => {
    const events: SseEvent[] = [
      {
        type: "tool",
        content: "Editing",
        toolName: "Edit",
        toolInput: {
          file_path: "/f.ts",
          old_string: "a\nb\nc",
          new_string: "a\nB\nc",
        },
      },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    const pre = container.querySelector("pre");
    // 'a' and 'c' should appear as context (no bg color), only 'b' removed and 'B' added
    expect(pre!.querySelectorAll(".bg-red-950\\/40").length).toBe(1);
    expect(pre!.querySelectorAll(".bg-green-950\\/40").length).toBe(1);
  });

  test("renders Bash tool with command in a code block", () => {
    const events: SseEvent[] = [
      {
        type: "tool",
        content: "Running",
        toolName: "Bash",
        toolInput: { command: "bun test", description: "Run tests" },
      },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.textContent).toContain("Bash(bun test)");
    expect(container.textContent).toContain("Run tests");
    expect(container.querySelector("pre")?.textContent).toBe("bun test");
  });

  test("falls back to italic one-liner when tool event has no toolName", () => {
    const events: SseEvent[] = [
      { type: "tool", content: "<b>Read:</b> foo.txt" },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.querySelector("b")?.textContent).toBe("Read:");
  });

  test("strips <script> via DOMPurify", () => {
    const events: SseEvent[] = [
      { type: "tool", content: `<b>ok</b><script>window.x=1</script>` },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")?.textContent).toBe("ok");
  });

  test("ToolBlock with successful result renders a green bullet", () => {
    const events: SseEvent[] = [
      {
        type: "tool",
        content: "Reading foo.ts",
        toolName: "Read",
        toolInput: { file_path: "/foo.ts" },
        toolUseId: "tu_a",
      },
      {
        type: "tool_result",
        content: "ok",
        toolUseId: "tu_a",
        isError: false,
      },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.querySelector(".text-green-400")).not.toBeNull();
  });

  test("ToolBlock with error result renders a red bullet", () => {
    const events: SseEvent[] = [
      {
        type: "tool",
        content: "Reading foo.ts",
        toolName: "Read",
        toolInput: { file_path: "/foo.ts" },
        toolUseId: "tu_b",
      },
      {
        type: "tool_result",
        content: "ENOENT",
        toolUseId: "tu_b",
        isError: true,
      },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.querySelector(".text-red-400")).not.toBeNull();
  });

  test("ToolBlock without a result keeps muted bullet (unresolved)", () => {
    const events: SseEvent[] = [
      {
        type: "tool",
        content: "Reading foo.ts",
        toolName: "Read",
        toolInput: { file_path: "/foo.ts" },
        toolUseId: "tu_c",
      },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.querySelector(".text-green-400")).toBeNull();
    expect(container.querySelector(".text-red-400")).toBeNull();
  });

  test("Bash success result shows first 3 lines and +N indicator", () => {
    const longOutput = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    const events: SseEvent[] = [
      {
        type: "tool",
        content: "Bash(ls)",
        toolName: "Bash",
        toolInput: { command: "ls" },
        toolUseId: "tu_bash",
      },
      {
        type: "tool_result",
        content: longOutput,
        toolUseId: "tu_bash",
        isError: false,
      },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.textContent).toContain("line 1");
    expect(container.textContent).toContain("line 3");
    expect(container.textContent).not.toContain("line 12");
    expect(container.textContent).toMatch(/\+9 lines/);
  });

  test("Grep success result shows match count summary", () => {
    const grepOutput = "src/a.ts: 3 matches\nsrc/b.ts: 1 match\n";
    const events: SseEvent[] = [
      {
        type: "tool",
        content: 'Grep("foo")',
        toolName: "Grep",
        toolInput: { pattern: "foo" },
        toolUseId: "tu_grep",
      },
      {
        type: "tool_result",
        content: grepOutput,
        toolUseId: "tu_grep",
        isError: false,
      },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.textContent).toMatch(/Found .* matches/i);
  });

  test("Read success result renders no body (suppressed on success)", () => {
    const events: SseEvent[] = [
      {
        type: "tool",
        content: "Read(foo.ts)",
        toolName: "Read",
        toolInput: { file_path: "/foo.ts" },
        toolUseId: "tu_r",
      },
      {
        type: "tool_result",
        content: "<file contents 100 lines>",
        toolUseId: "tu_r",
        isError: false,
      },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.querySelector(".text-green-400")).not.toBeNull();
    expect(container.textContent).not.toContain("<file contents");
  });

  test("any tool with error result shows error message body", () => {
    const events: SseEvent[] = [
      {
        type: "tool",
        content: "Read(foo.ts)",
        toolName: "Read",
        toolInput: { file_path: "/foo.ts" },
        toolUseId: "tu_err",
      },
      {
        type: "tool_result",
        content: "ENOENT: no such file or directory",
        toolUseId: "tu_err",
        isError: true,
      },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.textContent).toContain("ENOENT");
  });

  test("permission_mode plan shows yellow banner", () => {
    const events: SseEvent[] = [
      { type: "permission_mode", content: "plan", permissionMode: "plan" },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.textContent).toMatch(/Plan mode/i);
  });

  test("permission_mode default shows no banner", () => {
    const events: SseEvent[] = [
      { type: "permission_mode", content: "default", permissionMode: "default" },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.textContent).not.toMatch(/Plan mode|Auto-accept|Bypass/i);
  });

  test("most recent permission_mode wins (later events override earlier)", () => {
    const events: SseEvent[] = [
      { type: "permission_mode", content: "plan", permissionMode: "plan" },
      { type: "permission_mode", content: "default", permissionMode: "default" },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.textContent).not.toMatch(/Plan mode/i);
  });

  test("hook_summary renders as inline card with hook name and error", () => {
    const events: SseEvent[] = [
      {
        type: "hook_summary",
        content: "lint failed",
        hook: {
          hookCount: 1,
          errorCount: 1,
          preventedContinuation: true,
          firstError: "lint failed",
          failingHookName: "lint",
        },
      },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.textContent).toContain("lint");
    expect(container.textContent).toContain("lint failed");
  });

  test("renders user_message from telegram as a remote turn", () => {
    const events: SseEvent[] = [
      { type: "user_message", source: "telegram", content: "hi from telegram" },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.textContent).toContain("hi from telegram");
    expect(container.textContent).toContain("Telegram");
  });

  test("renders user_message from web with web label", () => {
    const events: SseEvent[] = [
      { type: "user_message", source: "web", content: "hi from web" },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.textContent).toContain("hi from web");
    expect(container.textContent).toContain("Web");
  });
});
