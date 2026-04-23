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
});
