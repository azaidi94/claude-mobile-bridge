/**
 * The single place this codebase shells out to tmux.
 *
 * Two call sites historically named the same server differently: the /tmux panel
 * hardcoded `-L claude` (a socket NAME), while terminal-inject passed `-S <path>`
 * (a socket PATH) read from the relay port file. Both reach the same server. The
 * send guard requires that a capture and a send-keys target the same pane, so the
 * naming is decided here, once.
 */

/** A tmux target: the pane id, and the socket PATH if the port file recorded one. */
export interface TmuxTarget {
  pane: string;
  socket?: string;
}

/** The launcher's dedicated socket name (see scripts/tmux/launch.sh). */
const CC_SOCKET = "claude";

/** Upper bound on one tmux invocation. A wedged server would otherwise hang every request. */
const TMUX_TIMEOUT_MS = 5_000;

/** `tmux -S <path>` when a socket path is known, else `tmux -L claude`. */
export function tmuxBase(target?: { socket?: string }): string[] {
  return target?.socket
    ? ["tmux", "-S", target.socket]
    : ["tmux", "-L", CC_SOCKET];
}

export function runTmux(argv: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  try {
    const r = Bun.spawnSync(argv, { timeout: TMUX_TIMEOUT_MS });
    return {
      ok: r.exitCode === 0,
      stdout: (r.stdout ?? Buffer.alloc(0)).toString(),
      stderr: (r.stderr ?? Buffer.alloc(0)).toString().trim(),
    };
  } catch (e) {
    // Bun.spawnSync THROWS on a missing binary (ENOENT) — e.g. tmux absent from
    // the launchd PATH. Return an error rather than crashing the handler.
    return { ok: false, stdout: "", stderr: `tmux not runnable: ${String(e)}` };
  }
}

/**
 * `list-panes` exits non-zero when NO server runs on the socket — the legitimate
 * "you have zero sessions" case, not a failure. Anything else (tmux missing,
 * socket permissions) is real and the user must see it.
 */
export function isNoServer(stderr: string): boolean {
  // Our own ENOENT wrapper can contain "no such file or directory", which IS a
  // real failure. Check it first.
  if (/not runnable/i.test(stderr)) return false;
  return /no server running|error connecting to/i.test(stderr);
}

/**
 * Read a pane's visible screen. Returns `""` on ANY failure — non-zero exit,
 * missing binary, or timeout.
 *
 * Callers MUST treat `""` as UNKNOWN STATE and never press Enter on it. Failing
 * closed costs a retry; failing open silently confirms a modal dialog.
 */
export function capturePane(target: TmuxTarget): string {
  const r = runTmux([
    ...tmuxBase(target),
    "capture-pane",
    "-p",
    "-t",
    target.pane,
  ]);
  return r.ok ? r.stdout : "";
}
