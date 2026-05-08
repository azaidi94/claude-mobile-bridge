/**
 * Tail-truncation rotation for cursor session JSONL files.
 *
 * The log writer keeps at most MAX_LINES (= 2000) lines per file by
 * rewriting it once growth exceeds MAX_LINES + ROTATE_HYSTERESIS.
 * The rewrite is atomic via tmp-rename so a crash never leaves the
 * file half-written.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { CursorSessionLog } from "../cursor/session-log";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cursor-log-rotate-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function lineCount(path: string): Promise<number> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter(Boolean).length;
}

async function readLines(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter(Boolean);
}

describe("CursorSessionLog tail truncation", () => {
  it("does not rotate when file is well under the cap", async () => {
    const log = new CursorSessionLog("under-cap", "/tmp/proj", tempDir);
    for (let i = 0; i < 100; i++) {
      await log.appendUser(`message ${i}`);
    }
    const path = join(tempDir, "under-cap.jsonl");
    expect(await lineCount(path)).toBe(100);
  });

  it("rotates once growth exceeds MAX_LINES + hysteresis", async () => {
    // Default constants: MAX_LINES=2000, ROTATE_HYSTERESIS=200.
    // After 2300 appends, rotation will have fired at append 2201
    // (cutting back to 2000), then 99 more appends grow it to 2099.
    const log = new CursorSessionLog("over-cap", "/tmp/proj", tempDir);
    for (let i = 0; i < 2300; i++) {
      await log.appendUser(`m${i}`);
    }
    const path = join(tempDir, "over-cap.jsonl");
    const count = await lineCount(path);
    // Bounded by MAX_LINES + ROTATE_HYSTERESIS = 2200; rotation
    // fires only when the bound is exceeded, so growth past 2000
    // up to 2200 is expected.
    expect(count).toBeLessThanOrEqual(2200);
    // Must be far less than the unrotated count (2300) — proving
    // rotation actually fired.
    expect(count).toBeLessThan(2300);
  });

  it("preserves the most recent entries on rotation (drops the oldest)", async () => {
    const log = new CursorSessionLog("preserve-tail", "/tmp/proj", tempDir);
    for (let i = 0; i < 2300; i++) {
      await log.appendUser(`m${i}`);
    }
    const path = join(tempDir, "preserve-tail.jsonl");
    const lines = await readLines(path);
    // The last entry must be the most recent message.
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last.message.content).toBe("m2299");
    // The first entry should be reasonably recent (not m0).
    const first = JSON.parse(lines[0]!);
    const firstIdx = parseInt(first.message.content.slice(1), 10);
    expect(firstIdx).toBeGreaterThan(100);
  });

  it("produces a parseable JSONL after rotation (no half-line on tail)", async () => {
    const log = new CursorSessionLog("parseable", "/tmp/proj", tempDir);
    for (let i = 0; i < 2400; i++) {
      await log.appendAssistant(`reply ${i}`);
    }
    const path = join(tempDir, "parseable.jsonl");
    const lines = await readLines(path);
    for (const line of lines) {
      // Each line must be valid JSON
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("counts existing lines on first append (resumes correctly)", async () => {
    // Pre-seed a file at 1900 lines (under cap). New writes should
    // accumulate and trigger rotation when we cross the threshold.
    const path = join(tempDir, "resume.jsonl");
    const seed =
      Array.from({ length: 1900 }, (_, i) =>
        JSON.stringify({
          type: "user",
          source: "cursor",
          message: { role: "user", content: `seed${i}` },
        }),
      ).join("\n") + "\n";
    await Bun.write(path, seed);

    const log = new CursorSessionLog("resume", "/tmp/proj", tempDir);
    // Push past 2200 total (1900 seed + 400 new = 2300).
    for (let i = 0; i < 400; i++) {
      await log.appendUser(`new${i}`);
    }
    const count = await lineCount(path);
    // Bounded by MAX_LINES + hysteresis after rotation fires.
    expect(count).toBeLessThanOrEqual(2200);
    expect(count).toBeLessThan(2300);
    // Last entry must be the most recent new message.
    const lines = await readLines(path);
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last.message.content).toBe("new399");
  });
});
