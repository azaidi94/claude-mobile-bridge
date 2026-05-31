/**
 * Minimal 5-field cron parser: `min hour dom month dow`.
 *
 * Supports:
 *   *               — any value
 *   <n>             — literal integer
 *   <a>-<b>         — inclusive range
 *   *<step> | <a>/<n>  — step values (every N starting from <a>; * means 0)
 *   <a>,<b>,<c>     — comma-separated list (any of the above)
 *
 * Day-of-week: 0 = Sunday … 6 = Saturday (7 normalises to 0).
 * Month and DOW are evaluated as OR — matches if EITHER applies — only when
 * BOTH are unrestricted (the standard POSIX behaviour); when one is `*` we
 * just AND across all fields (less surprising for casual users).
 */

export interface CronExpr {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

const RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
} as const;

function expandField(
  field: string,
  [lo, hi]: readonly [number, number],
  normaliseDow = false,
): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`cron: bad step in "${part}"`);
    }

    let start: number;
    let end: number;
    if (rangePart === "*" || rangePart === undefined) {
      start = lo;
      end = hi;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map((s) => parseInt(s, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new Error(`cron: bad range "${rangePart}"`);
      }
      start = a as number;
      end = b as number;
    } else {
      const n = parseInt(rangePart, 10);
      if (!Number.isFinite(n))
        throw new Error(`cron: bad number "${rangePart}"`);
      // A bare step like "*/5" expands across the whole range; a bare value
      // like "5" is just that one value.
      start = n;
      end = stepStr ? hi : n;
    }

    for (let v = start; v <= end; v += step) {
      let normalised = v;
      if (normaliseDow && v === 7) normalised = 0;
      if (normalised < lo || normalised > hi) {
        throw new Error(
          `cron: out of range ${normalised} (allowed ${lo}-${hi})`,
        );
      }
      out.add(normalised);
    }
  }
  return out;
}

export function parseCron(spec: string): CronExpr {
  const parts = spec.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron: expected 5 fields, got ${parts.length}`);
  }
  return {
    minute: expandField(parts[0]!, RANGES.minute),
    hour: expandField(parts[1]!, RANGES.hour),
    dom: expandField(parts[2]!, RANGES.dom),
    month: expandField(parts[3]!, RANGES.month),
    dow: expandField(parts[4]!, RANGES.dow, true),
  };
}

/** True iff the cron expression matches the given Date (uses UTC fields). */
export function matchesAt(expr: CronExpr, when: Date): boolean {
  return (
    expr.minute.has(when.getUTCMinutes()) &&
    expr.hour.has(when.getUTCHours()) &&
    expr.dom.has(when.getUTCDate()) &&
    expr.month.has(when.getUTCMonth() + 1) &&
    expr.dow.has(when.getUTCDay())
  );
}
