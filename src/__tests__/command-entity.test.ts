import { describe, expect, test } from "bun:test";
import { ensureCommandEntity } from "../command-entity";

describe("ensureCommandEntity", () => {
  test("adds a bot_command entity when text starts with /word and none exists", () => {
    const msg = {
      text: "/new ~/Projects/x",
      entities: [{ type: "code", offset: 0, length: 17 }],
    };
    expect(ensureCommandEntity(msg)).toBe(true);
    expect(msg.entities[0]).toEqual({
      type: "bot_command",
      offset: 0,
      length: 4,
    });
    // formatting entity is dropped so it cannot overlap the command
    expect(msg.entities).toHaveLength(1);
  });

  test("handles a pre entity and no entities array", () => {
    const msg: {
      text: string;
      entities?: { type: string; offset: number; length: number }[];
    } = {
      text: "/list",
    };
    expect(ensureCommandEntity(msg)).toBe(true);
    expect(msg.entities).toEqual([
      { type: "bot_command", offset: 0, length: 5 },
    ]);
  });

  test("keeps the @bot suffix in the command length", () => {
    const msg = {
      text: "/new@MyBot path",
      entities: [{ type: "pre", offset: 0, length: 15 }],
    };
    ensureCommandEntity(msg);
    expect(msg.entities[0]).toEqual({
      type: "bot_command",
      offset: 0,
      length: 10,
    });
  });

  test("is a no-op when a bot_command entity already exists at offset 0", () => {
    const entities = [{ type: "bot_command", offset: 0, length: 4 }];
    const msg = { text: "/new x", entities };
    expect(ensureCommandEntity(msg)).toBe(false);
    expect(msg.entities).toBe(entities);
  });

  test("is a no-op for non-command text", () => {
    for (const text of ["hello", " /new", "/", "/ new", "//x", "/日本"]) {
      const msg = {
        text,
        entities: [{ type: "code", offset: 0, length: text.length }],
      };
      expect(ensureCommandEntity(msg)).toBe(false);
      expect(msg.entities[0]?.type).toBe("code");
    }
  });

  test("keeps non-overlapping entities after the command", () => {
    const msg = {
      text: "/new ~/x",
      entities: [
        { type: "code", offset: 0, length: 4 },
        { type: "bold", offset: 5, length: 3 },
      ],
    };
    ensureCommandEntity(msg);
    expect(msg.entities).toEqual([
      { type: "bot_command", offset: 0, length: 4 },
      { type: "bold", offset: 5, length: 3 },
    ]);
  });
});
