import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KanbanBoard } from "../components/KanbanBoard";
import type { TaskPayload, TaskSession } from "../api";

const session: TaskSession = {
  id: "s1",
  name: "my-project",
  projectDir: "/Users/x/my-project",
};

const tasks: TaskPayload[] = [
  {
    sessionId: "s1",
    id: "1",
    subject: "Pending task",
    description: "",
    status: "pending",
    updatedAt: Date.now() - 1000,
  },
  {
    sessionId: "s1",
    id: "2",
    subject: "Working task",
    description: "",
    status: "in_progress",
    updatedAt: Date.now() - 2000,
  },
  {
    sessionId: "s1",
    id: "3",
    subject: "Done task",
    description: "",
    status: "completed",
    updatedAt: Date.now() - 3000,
  },
];

describe("KanbanBoard", () => {
  test("renders three status columns", () => {
    render(
      <KanbanBoard
        tasks={tasks}
        sessionsById={new Map([["s1", session]])}
        showSessionLabel={false}
        onCardTap={() => {}}
      />,
    );
    expect(screen.getByTestId("kanban-col-pending")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-col-in_progress")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-col-completed")).toBeInTheDocument();
  });

  test("groups tasks by status into correct columns", () => {
    render(
      <KanbanBoard
        tasks={tasks}
        sessionsById={new Map([["s1", session]])}
        showSessionLabel={false}
        onCardTap={() => {}}
      />,
    );
    const pending = screen.getByTestId("kanban-col-pending");
    const inProgress = screen.getByTestId("kanban-col-in_progress");
    const completed = screen.getByTestId("kanban-col-completed");
    expect(pending.textContent).toContain("Pending task");
    expect(inProgress.textContent).toContain("Working task");
    expect(completed.textContent).toContain("Done task");
  });

  test("hides session label when showSessionLabel is false", () => {
    render(
      <KanbanBoard
        tasks={tasks}
        sessionsById={new Map([["s1", session]])}
        showSessionLabel={false}
        onCardTap={() => {}}
      />,
    );
    expect(screen.queryAllByTestId("session-label")).toHaveLength(0);
  });

  test("shows session label when showSessionLabel is true", () => {
    render(
      <KanbanBoard
        tasks={tasks}
        sessionsById={new Map([["s1", session]])}
        showSessionLabel={true}
        onCardTap={() => {}}
      />,
    );
    expect(screen.getAllByTestId("session-label").length).toBe(tasks.length);
  });

  test("fires onCardTap with the tapped task", () => {
    const onCardTap = vi.fn();
    render(
      <KanbanBoard
        tasks={tasks}
        sessionsById={new Map([["s1", session]])}
        showSessionLabel={false}
        onCardTap={onCardTap}
      />,
    );
    const cards = screen.getAllByTestId("kanban-card");
    fireEvent.click(cards[0]!);
    expect(onCardTap).toHaveBeenCalledTimes(1);
    expect(onCardTap.mock.calls[0]![0].id).toMatch(/^[123]$/);
  });
});
