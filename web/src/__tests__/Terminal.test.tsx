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

  test("strips <script> via DOMPurify", () => {
    const events: SseEvent[] = [
      { type: "tool", content: `<b>ok</b><script>window.x=1</script>` },
    ];
    const { container } = render(<Terminal events={events} streaming={false} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")?.textContent).toBe("ok");
  });
});
