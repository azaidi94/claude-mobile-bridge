import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "topic-ledger-test-"));
  process.env.CLAUDE_TELEGRAM_LEDGER_FILE = join(dir, "topic-ledger.jsonl");
});

afterEach(async () => {
  delete process.env.CLAUDE_TELEGRAM_LEDGER_FILE;
  await rm(dir, { recursive: true, force: true });
});

describe("topic-ledger", () => {
  test("readLedger on a missing file returns empty", async () => {
    const { readLedger } = await import("../topics/topic-ledger");
    expect(await readLedger()).toEqual([]);
  });

  test("records created topics and reads them back as active", async () => {
    const { recordTopicCreated, readActiveLedger } =
      await import("../topics/topic-ledger");
    await recordTopicCreated({
      topicId: 100,
      sessionName: "alpha",
      sessionDir: "/repo/alpha",
      sessionId: "id-a",
    });
    await recordTopicCreated({
      topicId: 200,
      sessionName: "beta",
      sessionDir: "/repo/beta",
    });

    const active = await readActiveLedger();
    expect(active.map((e) => e.topicId).sort()).toEqual([100, 200]);
    const alpha = active.find((e) => e.topicId === 100)!;
    expect(alpha.sessionName).toBe("alpha");
    expect(alpha.sessionId).toBe("id-a");
  });

  test("a deleted event tombstones the entry — excluded from active", async () => {
    const {
      recordTopicCreated,
      recordTopicDeleted,
      readLedger,
      readActiveLedger,
    } = await import("../topics/topic-ledger");
    await recordTopicCreated({
      topicId: 100,
      sessionName: "alpha",
      sessionDir: "/repo/alpha",
    });
    await recordTopicCreated({
      topicId: 200,
      sessionName: "beta",
      sessionDir: "/repo/beta",
    });
    await recordTopicDeleted(100);

    const active = await readActiveLedger();
    expect(active.map((e) => e.topicId)).toEqual([200]);

    // The full ledger still carries the deleted entry, with a deletedAt stamp.
    const all = await readLedger();
    const alpha = all.find((e) => e.topicId === 100)!;
    expect(alpha.deletedAt).toBeTruthy();
  });

  test("newest event wins — recreating a topic id clears the tombstone", async () => {
    const { recordTopicCreated, recordTopicDeleted, readActiveLedger } =
      await import("../topics/topic-ledger");
    await recordTopicCreated({
      topicId: 100,
      sessionName: "alpha",
      sessionDir: "/repo/alpha",
    });
    await recordTopicDeleted(100);
    await recordTopicCreated({
      topicId: 100,
      sessionName: "alpha-again",
      sessionDir: "/repo/alpha",
    });

    const active = await readActiveLedger();
    expect(active.map((e) => e.topicId)).toEqual([100]);
    expect(active[0]!.sessionName).toBe("alpha-again");
  });

  test("a deleted event with no prior created is kept as a tombstone", async () => {
    const { recordTopicDeleted, readLedger, readActiveLedger } =
      await import("../topics/topic-ledger");
    await recordTopicDeleted(999);
    expect(await readActiveLedger()).toEqual([]);
    expect((await readLedger()).map((e) => e.topicId)).toEqual([999]);
  });

  test("skips torn/partial lines without throwing", async () => {
    const { recordTopicCreated, readActiveLedger } =
      await import("../topics/topic-ledger");
    await recordTopicCreated({
      topicId: 100,
      sessionName: "alpha",
      sessionDir: "/repo/alpha",
    });
    // Simulate a partially-flushed final line from a crash mid-append.
    const { appendFile } = await import("fs/promises");
    await appendFile(process.env.CLAUDE_TELEGRAM_LEDGER_FILE!, '{"type":"crea');

    const active = await readActiveLedger();
    expect(active.map((e) => e.topicId)).toEqual([100]);
  });

  test("appends one JSONL line per event", async () => {
    const { recordTopicCreated, recordTopicDeleted } =
      await import("../topics/topic-ledger");
    await recordTopicCreated({
      topicId: 1,
      sessionName: "a",
      sessionDir: "/a",
    });
    await recordTopicDeleted(1);
    const raw = await readFile(
      process.env.CLAUDE_TELEGRAM_LEDGER_FILE!,
      "utf-8",
    );
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).type).toBe("created");
    expect(JSON.parse(lines[1]!).type).toBe("deleted");
  });
});
