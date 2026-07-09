import { describe, test, expect } from "bun:test";
import { topicSessionIdRefreshPlan } from "../sessions/topic-id-refresh";

describe("topicSessionIdRefreshPlan", () => {
  test("refreshes a topic whose stored sessionId is stale vs its live port file (R1, no launchUuid)", () => {
    const plan = topicSessionIdRefreshPlan(
      [],
      [{ topicName: "kinetix-agents", sessionId: "new-id" }],
      [{ sessionName: "kinetix-agents", sessionId: "stale-id" }],
    );
    expect(plan).toEqual([
      { sessionName: "kinetix-agents", sessionId: "new-id" },
    ]);
  });

  test("populates a topic that has no sessionId yet (R1, no launchUuid)", () => {
    const plan = topicSessionIdRefreshPlan(
      [],
      [{ topicName: "proj", sessionId: "id-1" }],
      [{ sessionName: "proj", sessionId: undefined }],
    );
    expect(plan).toEqual([{ sessionName: "proj", sessionId: "id-1" }]);
  });

  test("no-op when the stored id already matches (R1, no launchUuid)", () => {
    const plan = topicSessionIdRefreshPlan(
      [],
      [{ topicName: "proj", sessionId: "id-1" }],
      [{ sessionName: "proj", sessionId: "id-1" }],
    );
    expect(plan).toEqual([]);
  });

  test("ignores port files with no topicName or no sessionId (R1)", () => {
    const plan = topicSessionIdRefreshPlan(
      [],
      [
        { topicName: "proj", sessionId: undefined },
        { topicName: undefined, sessionId: "x" },
      ],
      [{ sessionName: "proj", sessionId: "old" }],
    );
    expect(plan).toEqual([]);
  });

  test("ignores port files whose topicName has no matching topic (R1)", () => {
    const plan = topicSessionIdRefreshPlan(
      [],
      [{ topicName: "unknown", sessionId: "id" }],
      [{ sessionName: "proj", sessionId: "old" }],
    );
    expect(plan).toEqual([]);
  });

  test("refuses to refresh when two live port files claim the same topic with different ids (sibling-safe, R1)", () => {
    const plan = topicSessionIdRefreshPlan(
      [],
      [
        { topicName: "proj", sessionId: "id-a" },
        { topicName: "proj", sessionId: "id-b" },
      ],
      [{ sessionName: "proj", sessionId: "old" }],
    );
    expect(plan).toEqual([]);
  });

  test("two port files agreeing on the same id is not ambiguous (R1)", () => {
    const plan = topicSessionIdRefreshPlan(
      [],
      [
        { topicName: "proj", sessionId: "id-a" },
        { topicName: "proj", sessionId: "id-a" },
      ],
      [{ sessionName: "proj", sessionId: "old" }],
    );
    expect(plan).toEqual([{ sessionName: "proj", sessionId: "id-a" }]);
  });

  test("registry heals a corrupt port file (key regression): registry wins over a corrupt port-file sessionId", () => {
    const plan = topicSessionIdRefreshPlan(
      [{ launchUuid: "U_A", sessionId: "aREAL" }],
      [{ topicName: "kx", sessionId: "bORPHAN" }],
      [{ sessionName: "kx", launchUuid: "U_A", sessionId: "bORPHAN" }],
    );
    expect(plan).toEqual([{ sessionName: "kx", sessionId: "aREAL" }]);
  });

  test("pending: launchUuid not yet in the registry → no update", () => {
    const plan = topicSessionIdRefreshPlan(
      [],
      [{ topicName: "kx", sessionId: "whatever" }],
      [{ sessionName: "kx", launchUuid: "U_NEW", sessionId: "old" }],
    );
    expect(plan).toEqual([]);
  });

  test("no-op when registry sessionId already matches the topic's current sessionId", () => {
    const plan = topicSessionIdRefreshPlan(
      [{ launchUuid: "U_A", sessionId: "id-1" }],
      [],
      [{ sessionName: "proj", launchUuid: "U_A", sessionId: "id-1" }],
    );
    expect(plan).toEqual([]);
  });

  test("hook-bearing topics are never matched via port-file topicName even if it would disagree with the registry", () => {
    const plan = topicSessionIdRefreshPlan(
      [{ launchUuid: "U_A", sessionId: "aREAL" }],
      [{ topicName: "proj", sessionId: "wrong-id" }],
      [{ sessionName: "proj", launchUuid: "U_A", sessionId: "old" }],
    );
    expect(plan).toEqual([{ sessionName: "proj", sessionId: "aREAL" }]);
  });
});
