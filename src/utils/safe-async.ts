import { debug, error, info, warn } from "../logger";

const sevMap = { debug, info, warn, error } as const;

export interface SafeAsyncOptions {
  /** What to do on error. Default: "log" (swallow, log, return undefined). */
  onError?: "log" | "throw" | "log-and-throw";
  /** Log severity. Default: "warn". */
  severity?: "debug" | "info" | "warn" | "error";
  /** Extra structured fields to attach to the log line. */
  fields?: Record<string, unknown>;
}

function logFailure(label: string, err: unknown, opts?: SafeAsyncOptions) {
  const severity = opts?.severity ?? "warn";
  const msg = `${label} failed`;
  if (severity === "warn") {
    warn(msg, err, opts?.fields);
  } else if (severity === "error") {
    error(msg, err, opts?.fields);
  } else {
    // info / debug only take (msg, fields) — fold err into fields.
    const e = err as Error | undefined;
    sevMap[severity](msg, {
      ...(opts?.fields ?? {}),
      err_name: e?.name,
      err_msg: e?.message,
    });
  }
}

/**
 * Run an async fn; if it throws, log with a consistent schema then either
 * swallow (default) or re-throw. The `label` becomes the log message —
 * use dotted snake_case (e.g. "topic.delete", "relay.connect") so every
 * swallowed error has a unique grep handle in logs.
 *
 * No more invisible failures.
 */
export async function safeAsync<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: SafeAsyncOptions,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    logFailure(label, err, opts);
    if (opts?.onError === "throw" || opts?.onError === "log-and-throw")
      throw err;
    return undefined;
  }
}

/**
 * Synchronous variant. Same shape, no Promise.
 */
export function safeSync<T>(
  label: string,
  fn: () => T,
  opts?: SafeAsyncOptions,
): T | undefined {
  try {
    return fn();
  } catch (err) {
    logFailure(label, err, opts);
    if (opts?.onError === "throw" || opts?.onError === "log-and-throw")
      throw err;
    return undefined;
  }
}
