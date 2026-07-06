/**
 * Pure parser for the ralph loop's stdout (mirrored to run.log by the outer
 * `script -q -F`). No IO — the monitor feeds it raw chunks and gets back
 * structured events.
 *
 * The loop echoes terminal-state lines at column 0 in plain text (afk_tasks.sh).
 * Between them, claude's TUI redraws paint boxed/indented text and rewrite lines
 * with carriage returns and ANSI escapes — none of which starts at column 0
 * after we strip escapes and keep only the content after the last `\r`. So the
 * six markers are matched anchored at line start (invariant 6). Anything else is
 * dropped.
 */

export type RalphEvent =
  | { type: "iteration"; n: number; total: number }
  | { type: "waiting" }
  | { type: "no-issues" }
  | { type: "complete"; iterations: number }
  | { type: "timeout"; seconds: number }
  | { type: "max-iterations"; n: number };

// CSI (Control Sequence Introducer) escapes, e.g. colour + cursor moves.
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// OSC (Operating System Command) escapes, e.g. window-title sets.
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Strip a single raw line to comparable plain text. */
function clean(line: string): string {
  // Drop trailing carriage returns, then take the content after the LAST \r —
  // TUI overwrites rewrite the same row, and only the final paint survives.
  const afterCr = line.replace(/\r+$/, "").split("\r").pop() ?? "";
  return afterCr.replace(ANSI_OSC, "").replace(ANSI_CSI, "");
}

function matchLine(clean: string): RalphEvent | null {
  let m: RegExpMatchArray | null;

  if ((m = clean.match(/^=== Iteration (\d+)\/(\d+) ===/))) {
    return { type: "iteration", n: Number(m[1]), total: Number(m[2]) };
  }
  if (/^No open issues\. All done!/.test(clean)) {
    return { type: "no-issues" };
  }
  if (/^Waiting for other agents/.test(clean)) {
    return { type: "waiting" };
  }
  if ((m = clean.match(/^All issues resolved after (\d+) iterations\./))) {
    return { type: "complete", iterations: Number(m[1]) };
  }
  if ((m = clean.match(/^Timeout after (\d+)s/))) {
    return { type: "timeout", seconds: Number(m[1]) };
  }
  if ((m = clean.match(/^Reached max iterations \((\d+)\)/))) {
    return { type: "max-iterations", n: Number(m[1]) };
  }
  return null;
}

export class RalphLogParser {
  private partial = "";

  /** Feed a raw chunk from run.log; returns newly parsed events in order. */
  push(chunk: string): RalphEvent[] {
    this.partial += chunk;
    const parts = this.partial.split("\n");
    // Last element is an incomplete line (no trailing \n yet) — hold it.
    this.partial = parts.pop() ?? "";
    const events: RalphEvent[] = [];
    for (const raw of parts) {
      const ev = matchLine(clean(raw));
      if (ev) events.push(ev);
    }
    return events;
  }
}
