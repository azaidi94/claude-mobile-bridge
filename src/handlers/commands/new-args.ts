/**
 * Argument parser for `/new`.
 *
 *   /new [path]                 open a fresh session in path (default: working dir)
 *   /new --branch | -b          fork the current topic's session (resume + --fork-session)
 *   /new --resume <id> | -r <id> [path]
 *                               resume a dormant transcript in a new desktop session
 *
 * Pure — no IO — so it is unit-testable and reusable by the button menu.
 */

export interface NewArgs {
  path?: string;
  resume?: string;
  branch: boolean;
  error?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export function parseNewArgs(text: string): NewArgs {
  const toks = text.trim().split(/\s+/).slice(1);
  let resume: string | undefined;
  let branch = false;
  const rest: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t === "--branch" || t === "-b") {
      branch = true;
    } else if (t === "--resume" || t === "-r") {
      const id = toks[++i];
      if (!id || !isSessionUuid(id)) {
        return { branch, error: "--resume needs a session id (uuid)." };
      }
      resume = id.toLowerCase();
    } else if (t.startsWith("-")) {
      return { branch, error: `Unknown flag ${t}.` };
    } else {
      rest.push(t);
    }
  }
  if (branch && resume) {
    return {
      branch,
      resume,
      error: "Use either --branch or --resume, not both.",
    };
  }
  const out: NewArgs = { branch };
  if (resume) out.resume = resume;
  if (rest.length) out.path = rest.join(" ");
  return out;
}
