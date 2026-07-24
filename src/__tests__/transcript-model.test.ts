/**
 * Unit tests for reading a session's real model from its JSONL transcript.
 */

import "./ensure-test-env";
import { describe, expect, test } from "bun:test";
import { writeFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir, homedir } from "os";

import { readTranscriptModel } from "../sessions/transcript-model";
import { getModelDisplayName } from "../session";
import { encodeClaudeProjectDir } from "../paths";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

function assistantLine(model: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "assistant",
    message: { model, content: [{ type: "text", text: "hi" }] },
    ...extra,
  });
}

/** A user entry padded to `bytes` — stands in for a base64 image line. */
function hugeUserLine(bytes: number) {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "text", text: "x".repeat(bytes) }] },
  });
}

/** Write lines into a real ~/.claude/projects dir and run `fn` against it. */
async function withTranscript(
  lines: string[],
  fn: (ctx: { cwd: string; sessionId: string }) => Promise<void>,
): Promise<void> {
  const cwd = join(tmpdir(), `tm.proj-${Date.now()}-${Math.random()}`);
  const sessionId = `tm-session-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const projectDir = join(PROJECTS_DIR, encodeClaudeProjectDir(cwd));
  await mkdir(projectDir, { recursive: true });
  try {
    await writeFile(
      join(projectDir, `${sessionId}.jsonl`),
      lines.join("\n") + "\n",
    );
    await fn({ cwd, sessionId });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

describe("transcript-model: readTranscriptModel", () => {
  test("returns null when nothing resolves", async () => {
    expect(await readTranscriptModel(undefined, undefined)).toBeNull();
    expect(await readTranscriptModel("no-such-session")).toBeNull();
  });

  test("reads the newest model by sessionId", async () => {
    await withTranscript(
      [assistantLine("claude-opus-4-8"), assistantLine("claude-opus-5")],
      async ({ sessionId }) => {
        expect(await readTranscriptModel(sessionId)).toBe("claude-opus-5");
      },
    );
  });

  test("falls back to the latest transcript in the working dir", async () => {
    await withTranscript(
      [assistantLine("claude-sonnet-4-6")],
      async ({ cwd }) => {
        expect(await readTranscriptModel(undefined, cwd)).toBe(
          "claude-sonnet-4-6",
        );
      },
    );
  });

  test("an unresolvable sessionId does NOT fall back to a sibling transcript", async () => {
    // A speculative/drifted id must yield null rather than the newest
    // transcript in the same cwd — that would report another session's model.
    await withTranscript(
      [assistantLine("claude-sonnet-4-6")],
      async ({ cwd }) => {
        expect(await readTranscriptModel("not-on-disk", cwd)).toBeNull();
      },
    );
  });

  test("skips sidechain (subagent) entries", async () => {
    await withTranscript(
      [
        assistantLine("claude-opus-5"),
        assistantLine("claude-haiku-4-5-20251001", { isSidechain: true }),
      ],
      async ({ sessionId }) => {
        expect(await readTranscriptModel(sessionId)).toBe("claude-opus-5");
      },
    );
  });

  test("skips synthetic entries and malformed lines", async () => {
    await withTranscript(
      [
        assistantLine("claude-opus-5"),
        assistantLine("<synthetic>"),
        "{not json",
      ],
      async ({ sessionId }) => {
        expect(await readTranscriptModel(sessionId)).toBe("claude-opus-5");
      },
    );
  });

  test("returns null for a transcript with no assistant entries", async () => {
    await withTranscript(
      [JSON.stringify({ type: "user", message: { content: "hello" } })],
      async ({ sessionId }) => {
        expect(await readTranscriptModel(sessionId)).toBeNull();
      },
    );
  });

  test("returns null for an empty file", async () => {
    const cwd = join(tmpdir(), `tm.empty-${Date.now()}-${Math.random()}`);
    const projectDir = join(PROJECTS_DIR, encodeClaudeProjectDir(cwd));
    await mkdir(projectDir, { recursive: true });
    try {
      await writeFile(join(projectDir, "tm-empty.jsonl"), "");
      expect(await readTranscriptModel("tm-empty")).toBeNull();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("finds the model past a trailing line larger than the tail window", async () => {
    // A pasted screenshot lands as one >512KB user line. Without widening the
    // window the tail holds only that partial line and the model is lost.
    await withTranscript(
      [assistantLine("claude-opus-5"), hugeUserLine(700 * 1024)],
      async ({ sessionId }) => {
        expect(await readTranscriptModel(sessionId)).toBe("claude-opus-5");
      },
    );
  });

  test("finds the model when the assistant entry sits far above the tail", async () => {
    await withTranscript(
      [
        assistantLine("claude-opus-5"),
        ...Array.from({ length: 12 }, () => hugeUserLine(80 * 1024)),
      ],
      async ({ sessionId }) => {
        expect(await readTranscriptModel(sessionId)).toBe("claude-opus-5");
      },
    );
  });
});

describe("transcript-model: model labels", () => {
  test("formats family + dotted version", () => {
    expect(getModelDisplayName("claude-opus-5")).toBe("Opus 5");
    expect(getModelDisplayName("claude-opus-4-6")).toBe("Opus 4.6");
    expect(getModelDisplayName("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(getModelDisplayName("claude-fable-5")).toBe("Fable 5");
  });

  test("strips release date and 1M suffix, in either order", () => {
    expect(getModelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(getModelDisplayName("claude-opus-5[1m]")).toBe("Opus 5");
    expect(getModelDisplayName("claude-haiku-4-5-20251001[1m]")).toBe(
      "Haiku 4.5",
    );
  });

  test("short aliases keep their table label", () => {
    expect(getModelDisplayName("opus")).toBe("Opus 4.6");
  });

  test("passes through unrecognised shapes", () => {
    expect(getModelDisplayName("claude-opus-next")).toBe("claude-opus-next");
    expect(getModelDisplayName("claude-3-5-sonnet-20241022")).toBe(
      "claude-3-5-sonnet-20241022",
    );
  });
});
