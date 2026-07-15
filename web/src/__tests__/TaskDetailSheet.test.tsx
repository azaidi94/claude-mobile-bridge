import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskDetailSheet } from "../components/TaskDetailSheet";
import type { TaskPayload, TaskSession } from "../api";

vi.mock("../api", () => ({
  api: {
    activateSession: vi.fn(),
  },
}));

import { api } from "../api";

const task: TaskPayload = {
  sessionId: "s1",
  id: "1",
  subject: "Fix the bug",
  description: "long desc",
  status: "in_progress",
  updatedAt: 1,
};

const session: TaskSession = {
  id: "s1",
  name: "proj",
  projectDir: "/workspace/proj",
  live: true,
};

beforeEach(() => {
  (api.activateSession as any).mockReset();
});

describe("TaskDetailSheet", () => {
  test("renders subject + description + session label", () => {
    render(
      <TaskDetailSheet
        task={task}
        session={session}
        onClose={vi.fn()}
        onSwitchToChat={vi.fn()}
      />,
    );

    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
    expect(screen.getByText("long desc")).toBeInTheDocument();
    expect(screen.getByText(/proj/)).toBeInTheDocument();
  });

  test('"Open in chat" fires the full flow', async () => {
    (api.activateSession as any).mockResolvedValue(undefined);

    const onSwitchToChat = vi.fn();
    const onClose = vi.fn();

    render(
      <TaskDetailSheet
        task={task}
        session={session}
        onClose={onClose}
        onSwitchToChat={onSwitchToChat}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open in chat/i }));

    await waitFor(() => {
      expect(api.activateSession).toHaveBeenCalledWith(session.name);
      expect(onSwitchToChat).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  test("button is disabled when session is undefined", () => {
    render(
      <TaskDetailSheet
        task={task}
        session={undefined}
        onClose={vi.fn()}
        onSwitchToChat={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /open in chat/i }),
    ).toBeDisabled();
  });

  test("backdrop click closes, inner click does not", () => {
    const onClose = vi.fn();

    const { container } = render(
      <TaskDetailSheet
        task={task}
        session={session}
        onClose={onClose}
        onSwitchToChat={vi.fn()}
      />,
    );

    const backdrop = container.querySelector(".fixed.inset-0");
    expect(backdrop).not.toBeNull();

    // Clicking the backdrop should call onClose
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockReset();

    // Clicking the heading inside the panel should NOT call onClose
    const heading = screen.getByText("Fix the bug");
    fireEvent.click(heading);
    expect(onClose).not.toHaveBeenCalled();
  });
});
