import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ChatPage } from "../pages/ChatPage";

vi.mock("../api", () => ({
  api: {
    getSessions: vi.fn(),
    getSessionHistory: vi.fn(),
    streamSession: vi.fn(),
    sendMessage: vi.fn(),
    activateSession: vi.fn(),
    spawnAgent: vi.fn(),
  },
}));

import { api } from "../api";

const session = {
  id: "s1",
  name: "sA",
  dir: "/x",
  lastActivity: 0,
  source: "telegram" as const,
  live: true,
  active: true,
};

beforeEach(() => {
  (api.getSessions as any).mockReset();
  (api.getSessionHistory as any).mockReset();
  (api.streamSession as any).mockReset();
  (api.sendMessage as any).mockReset();
  // Default: streamSession never fires events
  (api.streamSession as any).mockReturnValue(() => {});
});

describe("ChatPage", () => {
  test("seeds events from getSessionHistory on mount", async () => {
    (api.getSessions as any).mockResolvedValue([session]);
    (api.getSessionHistory as any).mockResolvedValue([
      { type: "text", content: "historical hello" },
    ]);

    render(<ChatPage />);

    await screen.findByText("historical hello");
  });

  test("history seeds BEFORE live events (ordering)", async () => {
    let capturedOnEvent: ((e: any) => void) | null = null;

    (api.getSessions as any).mockResolvedValue([session]);
    (api.getSessionHistory as any).mockResolvedValue([
      { type: "text", content: "history-first" },
    ]);
    (api.streamSession as any).mockImplementation(
      (_id: string, onEvent: (e: any) => void) => {
        capturedOnEvent = onEvent;
        return () => {};
      },
    );

    render(<ChatPage />);

    // Wait for history to render
    await screen.findByText("history-first");

    // Now fire a live stream event
    act(() => {
      capturedOnEvent!({ type: "text", content: "stream-second" });
    });

    await screen.findByText("stream-second");

    // Assert DOM order: history-first appears before stream-second
    const body = document.body.textContent ?? "";
    const histIdx = body.indexOf("history-first");
    const streamIdx = body.indexOf("stream-second");
    expect(histIdx).toBeGreaterThanOrEqual(0);
    expect(streamIdx).toBeGreaterThanOrEqual(0);
    expect(histIdx).toBeLessThan(streamIdx);
  });

  test("falls back to empty events if history fetch fails", async () => {
    (api.getSessions as any).mockResolvedValue([session]);
    (api.getSessionHistory as any).mockRejectedValue(new Error("not found"));

    // Should not throw
    render(<ChatPage />);

    // Give promises time to settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // "historical hello" should not appear since history failed
    expect(screen.queryByText("historical hello")).not.toBeInTheDocument();

    // The UI should still be mounted — the input should be present
    expect(
      screen.getByPlaceholderText("Message..."),
    ).toBeInTheDocument();
  });
});
