import { describe, test, expect } from "bun:test";
import { topicSessionIdRefreshPlan } from "../sessions/topic-id-refresh";

describe("topicSessionIdRefreshPlan", () => {
  test("refreshes a topic whose stored sessionId is stale vs its live port file", () => {
    const plan = topicSessionIdRefreshPlan(
      [{ topicName: "kinetix-agents", sessionId: "new-id" }],
      [{ sessionName: "kinetix-agents", sessionId: "stale-id" }],
    );
    expect(plan).toEqual([
      { sessionName: "kinetix-agents", sessionId: "new-id" },
    ]);
  });

  test("populates a topic that has no sessionId yet", () => {
    const plan = topicSessionIdRefreshPlan(
      [{ topicName: "proj", sessionId: "id-1" }],
      [{ sessionName: "proj", sessionId: undefined }],
    );
    expect(plan).toEqual([{ sessionName: "proj", sessionId: "id-1" }]);
  });

  test("no-op when the stored id already matches", () => {
    const plan = topicSessionIdRefreshPlan(
      [{ topicName: "proj", sessionId: "id-1" }],
      [{ sessionName: "proj", sessionId: "id-1" }],
    );
    expect(plan).toEqual([]);
  });

  test("ignores port files with no topicName or no sessionId", () => {
    const plan = topicSessionIdRefreshPlan(
      [
        { topicName: "proj", sessionId: undefined },
        { topicName: undefined, sessionId: "x" },
      ],
      [{ sessionName: "proj", sessionId: "old" }],
    );
    expect(plan).toEqual([]);
  });

  test("ignores port files whose topicName has no matching topic", () => {
    const plan = topicSessionIdRefreshPlan(
      [{ topicName: "unknown", sessionId: "id" }],
      [{ sessionName: "proj", sessionId: "old" }],
    );
    expect(plan).toEqual([]);
  });

  test("refuses to refresh when two live port files claim the same topic with different ids (sibling-safe)", () => {
    const plan = topicSessionIdRefreshPlan(
      [
        { topicName: "proj", sessionId: "id-a" },
        { topicName: "proj", sessionId: "id-b" },
      ],
      [{ sessionName: "proj", sessionId: "old" }],
    );
    expect(plan).toEqual([]);
  });

  test("two port files agreeing on the same id is not ambiguous", () => {
    const plan = topicSessionIdRefreshPlan(
      [
        { topicName: "proj", sessionId: "id-a" },
        { topicName: "proj", sessionId: "id-a" },
      ],
      [{ sessionName: "proj", sessionId: "old" }],
    );
    expect(plan).toEqual([{ sessionName: "proj", sessionId: "id-a" }]);
  });
});
