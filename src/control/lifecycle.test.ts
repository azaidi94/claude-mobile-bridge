import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Short dir: a Unix socket path must stay under ~104 bytes on macOS.
const dir = mkdtempSync(join(tmpdir(), "cmb-"));
process.env.CLAUDE_TELEGRAM_STATE_DIR = dir;
const { CONTROL_SOCKET, startControlServer, stopControlServer } =
  await import("./server");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// Run alone (`bun run test` isolates files): if another file already loaded
// ./server, CONTROL_SOCKET is the real bot's — never touch it.
const isolated = CONTROL_SOCKET === join(dir, "bot.sock");

const deps = {
  pid: 42,
  startedAt: "t",
  chatId: () => undefined,
  sessions: () => [],
  topics: () => [],
};

test.skipIf(!isolated)("socket is owner-only and answers /status", async () => {
  startControlServer(deps);
  expect(statSync(CONTROL_SOCKET).mode & 0o777).toBe(0o600);
  const res = await fetch("http://bot/status", { unix: CONTROL_SOCKET });
  expect(((await res.json()) as { pid: number }).pid).toBe(42);
  stopControlServer();
  expect(() => statSync(CONTROL_SOCKET)).toThrow();
});

test.skipIf(!isolated)(
  "stop leaves a socket another bot rebound in place",
  () => {
    startControlServer(deps);
    // a second bot unlinks and rebinds the path
    unlinkSync(CONTROL_SOCKET);
    writeFileSync(CONTROL_SOCKET, "");
    stopControlServer();
    expect(statSync(CONTROL_SOCKET).isFile()).toBe(true);
  },
);
