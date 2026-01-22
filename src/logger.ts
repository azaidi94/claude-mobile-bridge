/**
 * Structured logger with timestamps and colors.
 *
 * DEBUG=1 enables debug level logs.
 */

type Level = "info" | "warn" | "error" | "debug";

const COLORS = {
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  debug: "\x1b[90m", // gray
  reset: "\x1b[0m",
};

function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

export function log(level: Level, msg: string): void {
  if (level === "debug" && !process.env.DEBUG) return;
  console.log(
    `${COLORS[level]}${ts()} [${level.toUpperCase()}]${COLORS.reset} ${msg}`,
  );
}

export const info = (msg: string) => log("info", msg);
export const warn = (msg: string) => log("warn", msg);
export const error = (msg: string) => log("error", msg);
export const debug = (msg: string) => log("debug", msg);

/**
 * Truncate string for preview (50 chars default).
 */
export function truncate(s: string, len = 50): string {
  const clean = s.replace(/\n/g, " ").trim();
  return clean.length > len ? clean.slice(0, len) + "..." : clean;
}
