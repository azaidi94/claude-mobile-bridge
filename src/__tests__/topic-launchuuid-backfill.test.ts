import { describe, test, expect } from "bun:test";
import { topicLaunchUuidBackfillPlan } from "../sessions/topic-launchuuid-backfill";
import type { TopicMapping } from "../types";

const tm = (o: Partial<TopicMapping>): TopicMapping => ({
  topicId: 1,
  sessionName: "n",
  sessionDir: "/d",
  isOnline: true,
  createdAt: "t",
  ...o,
});

describe("topicLaunchUuidBackfillPlan", () => {
  test("plans a write only for id-bearing topics missing launchUuid with a map hit", () => {
    const topics = [
      tm({ sessionName: "a", sessionId: "s1" }),
      tm({ sessionName: "b", sessionId: "s2", launchUuid: "u2" }),
      tm({ sessionName: "c" }),
      tm({ sessionName: "d", sessionId: "s9" }),
    ];
    const map = new Map([
      ["s1", "u1"],
      ["s2", "u2"],
    ]);
    expect(topicLaunchUuidBackfillPlan(topics, map)).toEqual([
      { sessionName: "a", launchUuid: "u1" },
    ]);
  });
});
