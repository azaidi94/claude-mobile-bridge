/**
 * Structured logger with timestamps, level-aware output streams, and
 * lightweight key=value fields for easier grepping.
 *
 * Verbosity is controlled by LOG_LEVEL (error < warn < info < debug), default
 * `info`. DEBUG=1 is kept as a backward-compatible alias for LOG_LEVEL=debug
 * and, when set, wins over LOG_LEVEL.
 */

import { writeToBotLog } from "./log-rotation";

type Level = "info" | "warn" | "error" | "debug";
export type LogFields = Record<string, unknown>;

const COLORS = {
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  debug: "\x1b[90m", // gray
  reset: "\x1b[0m",
};

// Higher number = more verbose. A message is emitted when its level's severity
// is <= the configured threshold's severity.
const SEVERITY: Record<Level, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Read live (not a load-time constant) so LOG_LEVEL/DEBUG can be toggled at
// runtime — and so tests can flip it around a capture without re-importing.
function debugEnabled(): boolean {
  const v = process.env.DEBUG;
  return !!v && v !== "0" && v !== "false";
}

// Resolve the active verbosity threshold. DEBUG=1 forces `debug`; otherwise
// LOG_LEVEL is honored (case-insensitive), falling back to `info` when unset
// or unrecognized.
function thresholdSeverity(): number {
  if (debugEnabled()) return SEVERITY.debug;
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw && raw in SEVERITY) return SEVERITY[raw as Level];
  return SEVERITY.info;
}

/** True when `level` would be emitted under the current threshold. */
export function isLevelEnabled(level: Level): boolean {
  return SEVERITY[level] <= thresholdSeverity();
}
const COLORS_ENABLED = Boolean(process.stdout.isTTY || process.stderr.isTTY);

function ts(): string {
  return new Date().toISOString();
}

function isPlainObject(value: unknown): value is LogFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeError(err: unknown): LogFields {
  if (err instanceof Error) {
    const fields: LogFields = {
      err_name: err.name,
      err_msg: err.message,
    };

    if (err.stack) fields.err_stack = err.stack;

    const code = (err as Error & { code?: unknown }).code;
    if (code !== undefined) fields.err_code = code;

    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      fields.err_cause =
        cause instanceof Error
          ? `${cause.name}: ${cause.message}`
          : String(cause);
    }

    return fields;
  }

  return {
    err_msg: String(err),
  };
}

function normalizeFields(detail?: unknown, fields?: LogFields): LogFields {
  if (detail === undefined) return fields ?? {};
  if (detail instanceof Error) {
    return { ...serializeError(detail), ...(fields ?? {}) };
  }
  if (isPlainObject(detail)) {
    return { ...detail, ...(fields ?? {}) };
  }
  return { detail, ...(fields ?? {}) };
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function formatFields(fields: LogFields): string {
  const entries = Object.entries(fields).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) return "";
  return (
    " " +
    entries.map(([key, value]) => `${key}=${formatValue(value)}`).join(" ")
  );
}

export function log(
  level: Level,
  msg: string,
  detail?: unknown,
  fields?: LogFields,
): void {
  if (!isLevelEnabled(level)) return;

  const mergedFields = normalizeFields(detail, fields);
  const prefix = `${ts()} [${level.toUpperCase()}]`;
  const fieldStr = formatFields(mergedFields);

  // Console line (may include ANSI color). File line is always uncolored.
  const consoleLine = COLORS_ENABLED
    ? `${COLORS[level]}${prefix}${COLORS.reset} ${msg}${fieldStr}`
    : `${prefix} ${msg}${fieldStr}`;

  const stream =
    level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${consoleLine}\n`);

  // File always gets the uncolored version so bot.log stays ANSI-free.
  writeToBotLog(`${prefix} ${msg}${fieldStr}\n`);
}

export const info = (msg: string, fields?: LogFields) =>
  log("info", msg, fields);
export const warn = (msg: string, detail?: unknown, fields?: LogFields) =>
  log("warn", msg, detail, fields);
export const error = (msg: string, detail?: unknown, fields?: LogFields) =>
  log("error", msg, detail, fields);
export const debug = (msg: string, fields?: LogFields) =>
  log("debug", msg, fields);

export function createOpId(prefix = "op"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Canonical correlation fields for the message lifecycle. Attach these to
 * log lines along a request's path (handler → streaming → relay) so one
 * message can be traced end-to-end, e.g. `grep 'opId="text_..."' bot.log` or
 * `grep 'session="athletiq"' bot.log`. Prefer these exact key names over
 * ad-hoc ones (`sessionName`, `threadId`) so a single grep spans the codebase.
 *
 *   opId    — stable per-request id from createOpId()
 *   session — desktop/cursor session name the request targets
 *   topic   — Telegram forum topic id (message_thread_id)
 *   chatId  — Telegram chat id
 */
export type CorrelationFields = LogFields & {
  opId?: string;
  session?: string;
  topic?: number;
  chatId?: number;
};

export function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

/**
 * Truncate string for preview (50 chars default).
 */
export function truncate(s: string, len = 50): string {
  const clean = s.replace(/\n/g, " ").trim();
  return clean.length > len ? clean.slice(0, len) + "..." : clean;
}
