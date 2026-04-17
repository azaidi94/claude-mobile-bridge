/**
 * Unit tests for listOfflineSessions().
 */

import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// We'll test the helper functions by pointing them at temp dirs.
// listOfflineSessions reads PROJECTS_DIR from a module-level const, so we
// test the lower-level helpers directly via re-exports.
import { findNewestJsonlInDir, readCwdFromJsonl } from "../sessions/offline";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "offline-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("findNewestJsonlInDir", () => {
  test("returns null for empty directory", async () => {
    const result = await findNewestJsonlInDir(tmpDir);
    expect(result).toBeNull();
  });

  test("returns null for directory with no jsonl files", async () => {
    await writeFile(join(tmpDir, "foo.txt"), "hello");
    const result = await findNewestJsonlInDir(tmpDir);
    expect(result).toBeNull();
  });

  test("returns the single jsonl file", async () => {
    await writeFile(join(tmpDir, "abc.jsonl"), "{}");
    const result = await findNewestJsonlInDir(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.path).toContain("abc.jsonl");
  });

  test("returns the most recently modified jsonl", async () => {
    // Write two files; the second one is "newer" by modification order
    await writeFile(join(tmpDir, "old.jsonl"), '{"ts":1}');
    await Bun.sleep(10);
    await writeFile(join(tmpDir, "new.jsonl"), '{"ts":2}');
    const result = await findNewestJsonlInDir(tmpDir);
    expect(result!.path).toContain("new.jsonl");
  });
});

describe("readCwdFromJsonl", () => {
  test("returns null for empty file", async () => {
    const p = join(tmpDir, "empty.jsonl");
    await writeFile(p, "");
    expect(await readCwdFromJsonl(p)).toBeNull();
  });

  test("returns null when no line has cwd field", async () => {
    const p = join(tmpDir, "nocwd.jsonl");
    await writeFile(
      p,
      '{"type":"user","message":"hi"}\n{"type":"assistant"}\n',
    );
    expect(await readCwdFromJsonl(p)).toBeNull();
  });

  test("returns cwd from first line", async () => {
    const p = join(tmpDir, "has-cwd.jsonl");
    await writeFile(
      p,
      '{"type":"progress","cwd":"/Users/test/myproject"}\n{"type":"user"}\n',
    );
    expect(await readCwdFromJsonl(p)).toBe("/Users/test/myproject");
  });

  test("returns cwd from second line when first is file-history-snapshot", async () => {
    const p = join(tmpDir, "snapshot-first.jsonl");
    await writeFile(
      p,
      '{"type":"file-history-snapshot","snapshot":{}}\n{"type":"summary","cwd":"/Users/test/project2"}\n',
    );
    expect(await readCwdFromJsonl(p)).toBe("/Users/test/project2");
  });

  test("returns null for non-existent file", async () => {
    expect(await readCwdFromJsonl("/nonexistent/path.jsonl")).toBeNull();
  });
});
