import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { safeAsync, safeSync } from "../utils/safe-async";

// Capture writes to stderr (warn/error) and stdout (info/debug).
let stderrChunks: string[] = [];
let stdoutChunks: string[] = [];
let origStderrWrite: typeof process.stderr.write;
let origStdoutWrite: typeof process.stdout.write;
beforeEach(() => {
  stderrChunks = [];
  stdoutChunks = [];
  origStderrWrite = process.stderr.write.bind(process.stderr);
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  // biome-ignore lint: test stub
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  // biome-ignore lint: test stub
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stderr.write = origStderrWrite;
  process.stdout.write = origStdoutWrite;
});

const stderr = () => stderrChunks.join("");
const stdout = () => stdoutChunks.join("");

describe("safeAsync", () => {
  test("happy path returns value, no log", async () => {
    const result = await safeAsync("op.success", async () => 42);
    expect(result).toBe(42);
    expect(stderr()).toBe("");
  });

  test("throws → swallows and logs at warn by default", async () => {
    const result = await safeAsync("op.boom", async () => {
      throw new Error("nope");
    });
    expect(result).toBeUndefined();
    const out = stderr();
    expect(out).toContain("op.boom failed");
    expect(out).toContain("[WARN]");
    expect(out).toContain("nope");
  });

  test("label appears verbatim in log", async () => {
    await safeAsync("topic.delete", async () => {
      throw new Error("x");
    });
    expect(stderr()).toContain("topic.delete failed");
  });

  test('onError: "throw" re-throws after logging', async () => {
    await expect(
      safeAsync(
        "op.throw",
        async () => {
          throw new Error("boom");
        },
        { onError: "throw" },
      ),
    ).rejects.toThrow("boom");
    expect(stderr()).toContain("op.throw failed");
  });

  test('onError: "log-and-throw" re-throws after logging', async () => {
    await expect(
      safeAsync(
        "op.lat",
        async () => {
          throw new Error("boom");
        },
        { onError: "log-and-throw" },
      ),
    ).rejects.toThrow("boom");
    expect(stderr()).toContain("op.lat failed");
  });

  test('severity: "error" uses error level', async () => {
    await safeAsync(
      "op.bad",
      async () => {
        throw new Error("e");
      },
      { severity: "error" },
    );
    expect(stderr()).toContain("[ERROR]");
    expect(stderr()).toContain("op.bad failed");
  });

  test('severity: "debug" does not write to stderr', async () => {
    // debug level is gated by DEBUG=1 at logger module load — we only
    // assert it does not appear on stderr (i.e. not warn/error).
    await safeAsync(
      "op.dbg",
      async () => {
        throw new Error("e");
      },
      { severity: "debug" },
    );
    expect(stderr()).toBe("");
  });

  test('severity: "info" writes to stdout', async () => {
    await safeAsync(
      "op.inf",
      async () => {
        throw new Error("e");
      },
      { severity: "info" },
    );
    expect(stdout()).toContain("[INFO]");
    expect(stdout()).toContain("op.inf failed");
  });

  test("fields are forwarded into the log line", async () => {
    await safeAsync(
      "op.fields",
      async () => {
        throw new Error("e");
      },
      { fields: { chat_id: 123, topic_id: 7 } },
    );
    const out = stderr();
    expect(out).toContain("chat_id=123");
    expect(out).toContain("topic_id=7");
  });
});

describe("safeSync", () => {
  test("happy path returns value", () => {
    const result = safeSync("sync.ok", () => "hi");
    expect(result).toBe("hi");
    expect(stderr()).toBe("");
  });

  test("throws → swallow and log", () => {
    const result = safeSync("sync.boom", () => {
      throw new Error("sync-bad");
    });
    expect(result).toBeUndefined();
    expect(stderr()).toContain("sync.boom failed");
    expect(stderr()).toContain("sync-bad");
  });

  test('onError: "throw" re-throws', () => {
    expect(() =>
      safeSync(
        "sync.rt",
        () => {
          throw new Error("rt");
        },
        { onError: "throw" },
      ),
    ).toThrow("rt");
    expect(stderr()).toContain("sync.rt failed");
  });
});
