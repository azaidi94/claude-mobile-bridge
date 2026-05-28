/**
 * Phase 0 — characterisation-test helpers.
 *
 * These helpers wire up realistic state in the topic-store and session
 * registry, then exercise the session-resolution layer (`loadTopicSession`,
 * `isSessionTopic`, etc.) to verify which session a handler would route a
 * message to. They DO NOT drive a full TCP-relay round-trip — that path is
 * already well-covered by relay-discovery / relay-selection unit tests.
 *
 * The bug class Phase 1 risks is in session resolution. These tests lock
 * that down.
 */

import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

/* -------------------------------------------------------------------------- */
/* Env / state-dir setup                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Establish an isolated STATE_DIR + minimal env. Call BEFORE any
 * production-code dynamic import (paths.ts reads the env var at module
 * load time).
 *
 * Idempotent within a process: scenario tests running in the same Bun
 * process share one STATE_DIR. `paths.ts` caches `STATE_DIR` as a
 * `const` evaluated at first module load, so the first scenario file's
 * dir is the only one production code will ever scan. Returning the
 * cached dir keeps later files' port-file writes visible to the scan.
 */
let cachedStateDir: string | null = null;
export function setupIsolatedStateDir(): string {
  if (cachedStateDir) {
    process.env.CLAUDE_TELEGRAM_STATE_DIR = cachedStateDir;
    return cachedStateDir;
  }
  cachedStateDir = mkdtempSync(join(tmpdir(), "phase0-state-"));
  process.env.CLAUDE_TELEGRAM_STATE_DIR = cachedStateDir;
  process.env.TELEGRAM_BOT_TOKEN =
    process.env.TELEGRAM_BOT_TOKEN ?? "test-token";
  process.env.TELEGRAM_ALLOWED_USERS =
    process.env.TELEGRAM_ALLOWED_USERS ?? "12345";
  // One-shot cleanup on process exit. All scenario test files share the
  // same dir (paths.ts caches STATE_DIR at first module load), so we
  // can't tear it down in any individual file's afterAll — whichever
  // ran first would rip it out from under siblings. The OS cleans tmp
  // dirs eventually anyway; this exit hook is just polite.
  const captured = cachedStateDir;
  process.on("exit", () => {
    try {
      rmSync(captured, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
  return cachedStateDir;
}

/**
 * No-op when the shared dir is still in use by sibling test files.
 * See `setupIsolatedStateDir` for the rationale. Cleanup happens on
 * process exit instead.
 */
export function teardownStateDir(_dir: string): void {
  // intentional no-op — see setupIsolatedStateDir
}

/* -------------------------------------------------------------------------- */
/* Port-file fixtures                                                         */
/* -------------------------------------------------------------------------- */

export interface PortFileSpec {
  pid: number;
  port: number;
  cwd: string;
  sessionId?: string;
}

/**
 * Write a port file into the given STATE_DIR. Returns the filename so the
 * test can assert against scanPortFiles output if needed.
 */
export function writePortFile(stateDir: string, spec: PortFileSpec): string {
  const name = `channel-relay-test-${spec.pid}.json`;
  writeFileSync(
    join(stateDir, name),
    JSON.stringify(
      {
        port: spec.port,
        pid: spec.pid,
        ppid: spec.pid,
        sessionId: spec.sessionId,
        cwd: spec.cwd,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return name;
}

/* -------------------------------------------------------------------------- */
/* Mock grammy Context                                                        */
/* -------------------------------------------------------------------------- */

let nextMessageId = 100;

export interface MakeContextOpts {
  chatId: number;
  userId: number;
  username?: string;
  threadId?: number;
  text?: string;
  chatType?: "private" | "group" | "supergroup";
}

/**
 * Minimal grammy Context shape. Sufficient for the topic-router and
 * session-resolution layer; not sufficient for handlers that actually
 * call ctx.reply or ctx.api.sendMessage.
 */
export function makeContext(opts: MakeContextOpts): unknown {
  const chatType =
    opts.chatType ?? (opts.threadId !== undefined ? "supergroup" : "private");
  return {
    chat: {
      id: opts.chatId,
      type: chatType,
      is_forum: chatType === "supergroup",
    },
    from: {
      id: opts.userId,
      username: opts.username ?? "test-user",
      first_name: opts.username ?? "Test",
    },
    message: {
      message_id: nextMessageId++,
      text: opts.text ?? "",
      message_thread_id: opts.threadId,
      is_topic_message: opts.threadId !== undefined,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* JSONL fixtures                                                             */
/* -------------------------------------------------------------------------- */

export function projectDirFor(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
}

export function writeFakeJsonl(cwd: string, sessionId: string): string {
  const dir = projectDirFor(cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, "");
  return path;
}

export function cleanupProjectDir(cwd: string): void {
  try {
    rmSync(projectDirFor(cwd), { recursive: true, force: true });
  } catch {
    // silently ok: test teardown; dir may not exist and removal is non-fatal
  }
}
