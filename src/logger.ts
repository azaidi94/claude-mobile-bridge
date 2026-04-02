/**
 * Structured logger with timestamps, level-aware output streams, and
 * lightweight key=value fields for easier grepping.
 *
 * DEBUG=1 enables debug level logs.
 */

type Level = "info" | "warn" | "error" | "debug";
export type LogFields = Record<string, unknown>;

const COLORS = {
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  debug: "\x1b[90m", // gray
  reset: "\x1b[0m",
};

const DEBUG_ENABLED =
  !!process.env.DEBUG &&
  process.env.DEBUG !== "0" &&
  process.env.DEBUG !== "false";
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

function writeLine(level: Level, line: string): void {
  const stream =
    level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export function log(
  level: Level,
  msg: string,
  detail?: unknown,
  fields?: LogFields,
): void {
  if (level === "debug" && !DEBUG_ENABLED) return;

  const mergedFields = normalizeFields(detail, fields);
  const prefix = `${ts()} [${level.toUpperCase()}]`;
  const line = `${prefix} ${msg}${formatFields(mergedFields)}`;

  if (!COLORS_ENABLED) {
    writeLine(level, line);
    return;
  }

  writeLine(
    level,
    `${COLORS[level]}${prefix}${COLORS.reset} ${msg}${formatFields(mergedFields)}`,
  );
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
