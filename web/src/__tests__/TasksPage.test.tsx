import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { TasksPage } from "../pages/TasksPage";

vi.mock("../api", () => ({
  api: {
    getTasks: vi.fn(),
    streamTasks: vi.fn(),
    activateSession: vi.fn(),
  },
}));

import { api } from "../api";

let capturedOnEvent: ((e: any) => void) | null = null;

beforeEach(() => {
  capturedOnEvent = null;
  (api.getTasks as any).mockReset();
  (api.streamTasks as any).mockReset();
  (api.streamTasks as any).mockImplementation((fn: any) => {
    capturedOnEvent = fn;
    return () => {};
  });
});

afterEach(() => {
  localStorage.clear();
});

describe("TasksPage", () => {
  test("loads initial snapshot via api.getTasks and renders cards", async () => {
    (api.getTasks as any).mockResolvedValue({
      sessions: [{ id: "s1", name: "sA", projectDir: "/x", live: true }],
      tasks: [
        {
          sessionId: "s1",
          id: "1",
          subject: "Hello",
          description: "",
          status: "pending",
          updatedAt: 1,
        },
      ],
    });

    render(<TasksPage onSwitchToChat={vi.fn()} />);

    await screen.findByText("Hello");

    expect(screen.getByTestId("kanban-col-pending")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-col-in_progress")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-col-completed")).toBeInTheDocument();
  });

  test("applies a task.upsert event to state", async () => {
    (api.getTasks as any).mockResolvedValue({ sessions: [], tasks: [] });

    render(<TasksPage onSwitchToChat={vi.fn()} />);

    // Wait for loading to complete
    await screen.findByText("no tasks");

    act(() => {
      capturedOnEvent!({
        type: "task.upsert",
        sessionId: "s1",
        task: {
          sessionId: "s1",
          id: "7",
          subject: "Streamed",
          description: "",
          status: "in_progress",
          updatedAt: 1,
        },
      });
    });

    expect(await screen.findByText("Streamed")).toBeInTheDocument();
  });

  test("removes tasks on task.delete event", async () => {
    (api.getTasks as any).mockResolvedValue({
      sessions: [{ id: "s1", name: "sA", projectDir: "/x", live: true }],
      tasks: [
        {
          sessionId: "s1",
          id: "1",
          subject: "ToDelete",
          description: "",
          status: "pending",
          updatedAt: 1,
        },
      ],
    });

    render(<TasksPage onSwitchToChat={vi.fn()} />);

    await screen.findByText("ToDelete");

    act(() => {
      capturedOnEvent!({ type: "task.delete", sessionId: "s1", taskId: "1" });
    });

    expect(screen.queryByText("ToDelete")).not.toBeInTheDocument();
  });

  test("removes all tasks of a session on session.delete event", async () => {
    (api.getTasks as any).mockResolvedValue({
      sessions: [
        { id: "s1", name: "sA", projectDir: "/x", live: true },
        { id: "s2", name: "sB", projectDir: "/y", live: true },
      ],
      tasks: [
        {
          sessionId: "s1",
          id: "1",
          subject: "TaskA",
          description: "",
          status: "pending",
          updatedAt: 1,
        },
        {
          sessionId: "s2",
          id: "2",
          subject: "TaskB",
          description: "",
          status: "pending",
          updatedAt: 1,
        },
      ],
    });

    render(<TasksPage onSwitchToChat={vi.fn()} />);

    await screen.findByText("TaskA");
    await screen.findByText("TaskB");

    act(() => {
      capturedOnEvent!({ type: "session.delete", sessionId: "s1" });
    });

    expect(screen.queryByText("TaskA")).not.toBeInTheDocument();
    expect(screen.getByText("TaskB")).toBeInTheDocument();

    const select = screen.getByRole("combobox");
    const optionTexts = Array.from(select.querySelectorAll("option")).map(
      (o) => o.textContent,
    );
    expect(optionTexts).not.toContain("sA");
    expect(optionTexts).toContain("sB");
  });

  test("filter restricts to one session's tasks", async () => {
    (api.getTasks as any).mockResolvedValue({
      sessions: [
        { id: "s1", name: "sA", projectDir: "/x", live: true },
        { id: "s2", name: "sB", projectDir: "/y", live: true },
      ],
      tasks: [
        {
          sessionId: "s1",
          id: "1",
          subject: "TaskA",
          description: "",
          status: "pending",
          updatedAt: 1,
        },
        {
          sessionId: "s2",
          id: "2",
          subject: "TaskB",
          description: "",
          status: "pending",
          updatedAt: 1,
        },
      ],
    });

    render(<TasksPage onSwitchToChat={vi.fn()} />);

    await screen.findByText("TaskA");
    await screen.findByText("TaskB");

    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "s1" } });

    expect(screen.getByText("TaskA")).toBeInTheDocument();
    expect(screen.queryByText("TaskB")).not.toBeInTheDocument();
  });

  test("default 'active' filter hides tasks from ended sessions", async () => {
    (api.getTasks as any).mockResolvedValue({
      sessions: [
        { id: "s1", name: "sA", projectDir: "/x", live: true },
        { id: "s2", name: "sB", projectDir: "/y", live: false },
      ],
      tasks: [
        {
          sessionId: "s1",
          id: "1",
          subject: "LiveTask",
          description: "",
          status: "pending",
          updatedAt: 1,
        },
        {
          sessionId: "s2",
          id: "2",
          subject: "DeadTask",
          description: "",
          status: "pending",
          updatedAt: 1,
        },
      ],
    });

    render(<TasksPage onSwitchToChat={vi.fn()} />);

    await screen.findByText("LiveTask");
    expect(screen.queryByText("DeadTask")).not.toBeInTheDocument();

    // The ended session is still selectable, marked "(ended)".
    const select = screen.getByRole("combobox");
    const optionTexts = Array.from(select.querySelectorAll("option")).map(
      (o) => o.textContent,
    );
    expect(optionTexts).toContain("sB (ended)");

    // Switching to "All sessions" reveals the ended session's tasks.
    fireEvent.change(select, { target: { value: "all" } });
    expect(screen.getByText("DeadTask")).toBeInTheDocument();
  });

  test("a task.upsert flips a snapshot-ended session back to live", async () => {
    // Regression: an ended session (live:false at load) that then writes a task
    // must reappear under the default "active" filter, not stay hidden.
    (api.getTasks as any).mockResolvedValue({
      sessions: [{ id: "s1", name: "sA", projectDir: "/x", live: false }],
      tasks: [
        {
          sessionId: "s1",
          id: "1",
          subject: "OldTask",
          description: "",
          status: "pending",
          updatedAt: 1,
        },
      ],
    });

    render(<TasksPage onSwitchToChat={vi.fn()} />);

    // Default "active" filter hides the ended session's task.
    await screen.findByText("no tasks");
    expect(screen.queryByText("OldTask")).not.toBeInTheDocument();

    act(() => {
      capturedOnEvent!({
        type: "task.upsert",
        sessionId: "s1",
        task: {
          sessionId: "s1",
          id: "2",
          subject: "FreshTask",
          description: "",
          status: "in_progress",
          updatedAt: 2,
        },
      });
    });

    // Session is now live: both its tasks show under the active filter.
    expect(await screen.findByText("FreshTask")).toBeInTheDocument();
    expect(screen.getByText("OldTask")).toBeInTheDocument();
    // And it's no longer labelled "(ended)" in the picker.
    const optionTexts = Array.from(
      screen.getByRole("combobox").querySelectorAll("option"),
    ).map((o) => o.textContent);
    expect(optionTexts).toContain("sA");
    expect(optionTexts).not.toContain("sA (ended)");
  });
});
