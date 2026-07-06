import { describe, test, expect } from "bun:test";
import { topicRebindPlan } from "../topics/rebind";
import type { TopicMapping } from "../types";

function makeMapping(over: Partial<TopicMapping> = {}): TopicMapping {
  return {
    topicId: 100,
    sessionName: "proj-main",
    sessionDir: "/home/me/proj",
    isOnline: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    ...over,
  };
}

describe("topicRebindPlan", () => {
  test("matching topic → no-op", () => {
    const current = makeMapping({ topicId: 7 });
    expect(topicRebindPlan(current, 7)).toEqual({ action: "noop" });
  });

  test("diverged binding → rebind with old topic id", () => {
    const current = makeMapping({ topicId: 3 });
    expect(topicRebindPlan(current, 7)).toEqual({
      action: "rebind",
      oldTopicId: 3,
    });
  });

  test("no existing mapping → create", () => {
    expect(topicRebindPlan(undefined, 7)).toEqual({ action: "create" });
  });
});
