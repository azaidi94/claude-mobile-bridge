/**
 * Inject keystrokes (e.g. `/clear`, `/compact`) into a running desktop Claude
 * session's terminal TUI.
 *
 * Why this exists: the channel-relay delivers text to Claude *the assistant*
 * as a `<channel>` message — it can't trigger Claude Code *client* slash
 * commands, which must be typed into the TUI's input box. macOS also removed
 * TIOCSTI, so there's no generic "write to another process's stdin". Injection
 * is therefore per-terminal-app. The app is detected *per session* from the
 * claude pid's process ancestry (`detectTerminalApp`) — the global
 * `getTerminal()` is only a fallback, since different sessions can run in
 * different apps:
 *
 *   - cmux     → `cmux send` + `cmux send-key Enter` (socket; no focus steal),
 *                targeted by the `CMUX_WORKSPACE_ID` the relay server stamps
 *                into the session's port file (spawn-time registry as fallback).
 *   - iTerm2   → AppleScript `write text` to the session whose tty matches.
 *   - Terminal → AppleScript `do script … in <tab>` to the matching tty.
 *   - Ghostty  → System Events keystroke to the frontmost window (best-effort;
 *                no scripting API to target a specific window, needs focus +
 *                Accessibility).
 *
 * tty targeting (iTerm2/Terminal): the session's claude pid may run under the
 * `expect` launcher's inner pty, so we collect the tty of the claude pid AND
 * every ancestor (the terminal window's tty is one of them) and let AppleScript
 * write to whichever session/tab matches — keystrokes propagate through
 * `expect`'s `interact` down to claude.
 */

import { realpathSync } from "fs";
import type { TerminalApp } from "../../config";
import { getTerminal } from "../../settings";
import { debug, warn } from "../../logger";
import type { SessionContext } from "../../sessions/context";
import {
  scanPortFiles,
  selectRelayTarget,
  type PortFileData,
} from "../../relay";
import { escapeAppleScriptDoubleQuoted } from "./helpers";
import { resolveCmuxBin } from "./terminal-launchers";

// ── cmux workspace registry ────────────────────────────────────────────
// cmux `list-workspaces`/`tree` expose only workspace *titles* (the agent
// name), never the cwd — so the reliable session→workspace mapping is the
// `workspace:N` ref cmux prints when the bot spawns it. Keyed by canonical cwd.

const cmuxWorkspaceByCwd = new Map<string, string>();

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Parse the `workspace:N` ref from `cmux new-workspace` stdout (`OK workspace:80`).
 * Prefers the ref on the `OK …` success line so a diagnostic/warning line that
 * mentions an unrelated workspace earlier in stdout can't be mis-stored. */
export function parseCmuxRef(stdout: string): string | null {
  const ok = stdout.match(/\bOK\b[^\n]*?(workspace:[0-9a-fA-F-]+)/);
  if (ok) return ok[1]!;
  const any = stdout.match(/workspace:[0-9a-fA-F-]+/);
  return any ? any[0] : null;
}

/** Record the cmux workspace the bot spawned for `cwd`, so we can inject into it. */
export function rememberCmuxWorkspace(cwd: string, stdout: string): void {
  const ref = parseCmuxRef(stdout);
  if (!ref) return;
  cmuxWorkspaceByCwd.set(canonical(cwd), ref);
  debug(`inject: remembered cmux ${ref} for ${cwd}`);
}

/** Look up the cmux workspace ref for a session dir (undefined if unknown). */
export function getCmuxWorkspace(cwd: string): string | undefined {
  return cmuxWorkspaceByCwd.get(canonical(cwd));
}

/** Test seam — clears the in-memory registry. */
export function _resetCmuxRegistry(): void {
  cmuxWorkspaceByCwd.clear();
}

// ── pure builders (exported for unit tests) ─────────────────────────────

/**
 * The two argv batches to type `text` then submit it in a cmux workspace.
 * Targets by `--workspace` (not `--surface`): surfaces created via
 * `new-workspace --command` — exactly how the bot spawns — reject `--surface`
 * ("Surface is not a terminal"), but `--workspace` works for both those and
 * normal interactive surfaces. `workspaceRef` is a `CMUX_WORKSPACE_ID` UUID
 * (from the port file) or a `workspace:N` short ref (spawn-registry fallback).
 */
export function buildCmuxInjectArgvs(
  bin: string,
  workspaceRef: string,
  text: string,
): string[][] {
  return [
    [bin, "send", "--workspace", workspaceRef, "--", text],
    [bin, "send-key", "--workspace", workspaceRef, "Enter"],
  ];
}

/**
 * AppleScript that writes `text` (and a submitting newline) into the iTerm2
 * session OR Terminal.app tab whose tty is in `ttys`. No-op if none match.
 */
export function buildTtyWriteScript(
  app: "iterm2" | "terminal",
  ttys: string[],
  text: string,
): string {
  const list = ttys
    .map((t) => `"${escapeAppleScriptDoubleQuoted(t)}"`)
    .join(", ");
  const esc = escapeAppleScriptDoubleQuoted(text);
  // Writes to the FIRST session/tab whose tty matches, then returns 1 (via the
  // run handler) so the caller can tell a real injection from a silent
  // no-match. Returns 0 if no window/tab matched (e.g. it was closed, or the
  // app was mis-detected) — without this the script exits 0 and the caller
  // would falsely report success. Stopping at the first match also avoids
  // writing into a second session that happens to share an ancestor tty.
  if (app === "iterm2") {
    // `write text` appends a newline → the line is submitted.
    return [
      `set ttyList to {${list}}`,
      `tell application "iTerm2"`,
      `  repeat with w in windows`,
      `    repeat with t in tabs of w`,
      `      repeat with s in sessions of t`,
      `        if (tty of s) is in ttyList then`,
      `          write text "${esc}"`,
      `          return 1`,
      `        end if`,
      `      end repeat`,
      `    end repeat`,
      `  end repeat`,
      `end tell`,
      `return 0`,
    ].join("\n");
  }
  // Terminal.app: `do script … in <tab>` types into the existing tab and
  // presses return. Targeting an existing tab (not `do script` alone) avoids
  // opening a new window.
  return [
    `set ttyList to {${list}}`,
    `tell application "Terminal"`,
    `  repeat with w in windows`,
    `    repeat with t in tabs of w`,
    `      if (tty of t) is in ttyList then`,
    `        do script "${esc}" in t`,
    `        return 1`,
    `      end if`,
    `    end repeat`,
    `  end repeat`,
    `end tell`,
    `return 0`,
  ].join("\n");
}

/**
 * Best-effort System Events keystroke for Ghostty (no scripting API to target
 * a specific window). Activates Ghostty, types the text, presses return.
 */
export function buildGhosttyKeystrokeScript(text: string): string {
  const esc = escapeAppleScriptDoubleQuoted(text);
  return [
    `tell application "Ghostty" to activate`,
    `delay 0.2`,
    `tell application "System Events"`,
    `  keystroke "${esc}"`,
    `  key code 36`,
    `end tell`,
  ].join("\n");
}

// ── tty resolution ──────────────────────────────────────────────────────

/** One `ps` row: a process's parent pid and controlling tty (or null if none). */
export interface PsRow {
  ppid: number;
  tty: string | null;
}

/** Live `ps` lookup for a pid. `??` (no controlling tty) maps to null. */
function psLookup(pid: number): PsRow | null {
  const r = Bun.spawnSync(["ps", "-o", "ppid=,tty=", "-p", String(pid)]);
  if (r.exitCode !== 0) return null;
  const line = (r.stdout ?? Buffer.alloc(0)).toString().trim();
  if (!line) return null;
  const m = line.match(/^\s*(\d+)\s+(\S+)?/);
  if (!m) return null;
  const ttyRaw = m[2];
  const tty = !ttyRaw || ttyRaw === "??" ? null : `/dev/${ttyRaw}`;
  return { ppid: Number(m[1]), tty };
}

/**
 * Collect the controlling ttys of `pid` and all its ancestors. With the
 * `expect` launcher, claude runs on an inner pty while the terminal window's
 * tty belongs to an ancestor (the login shell), so both must be considered.
 * `lookup` is injectable for tests.
 */
export function ttyChainForPid(
  pid: number,
  lookup: (p: number) => PsRow | null = psLookup,
): string[] {
  const ttys = new Set<string>();
  let cur: number | undefined = pid;
  let hops = 0;
  while (cur !== undefined && cur > 1 && hops < 32) {
    const row = lookup(cur);
    if (!row) break;
    if (row.tty) ttys.add(row.tty);
    cur = row.ppid;
    hops++;
  }
  return [...ttys];
}

// ── per-session terminal-app detection ──────────────────────────────────

/** One `ps` row for ancestry walking: parent pid + executable path. */
export interface ProcRow {
  ppid: number;
  comm: string;
}

/** Live `ps -o ppid=,comm=` lookup (comm is the full executable path on macOS). */
function psComm(pid: number): ProcRow | null {
  const r = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)]);
  if (r.exitCode !== 0) return null;
  const line = (r.stdout ?? Buffer.alloc(0)).toString().trim();
  const m = line.match(/^\s*(\d+)\s+(.+)$/);
  if (!m) return null;
  return { ppid: Number(m[1]), comm: m[2]! };
}

/**
 * Determine which terminal app actually hosts `pid` by walking its process
 * ancestry and matching each ancestor's executable. The terminal app is a
 * global setting, but different sessions can run in different apps (cmux here,
 * Apple Terminal there) — injection must route per-session, not by the global
 * default. Returns undefined when no known app is found (caller falls back to
 * `getTerminal()`). `lookup` is injectable for tests.
 *
 * Order matters: cmux embeds Ghostty (its ancestor exec is `…/cmux`, and its
 * shells report TERM_PROGRAM=ghostty), so cmux must be matched before ghostty.
 */
export function detectTerminalApp(
  pid: number,
  lookup: (p: number) => ProcRow | null = psComm,
): TerminalApp | undefined {
  let cur: number | undefined = pid;
  let hops = 0;
  while (cur !== undefined && cur > 1 && hops < 32) {
    const row = lookup(cur);
    if (!row) break;
    const c = row.comm.toLowerCase();
    if (c.includes("cmux")) return "cmux";
    if (c.includes("iterm")) return "iterm2";
    if (c.includes("ghostty")) return "ghostty";
    if (c.includes("terminal.app") || c.endsWith("/terminal"))
      return "terminal";
    cur = row.ppid;
    hops++;
  }
  return undefined;
}

// ── orchestration ───────────────────────────────────────────────────────

export type InjectResult =
  | { ok: true; app: TerminalApp; note?: string }
  | { ok: false; app: TerminalApp; reason: string };

function runOsascript(script: string): {
  ok: boolean;
  stderr: string;
  stdout: string;
} {
  const r = Bun.spawnSync(["osascript", "-e", script]);
  const stderr = (r.stderr ?? Buffer.alloc(0)).toString().trim();
  const stdout = (r.stdout ?? Buffer.alloc(0)).toString().trim();
  return { ok: r.exitCode === 0, stderr, stdout };
}

/**
 * Resolve which cmux workspace to inject into for `sctx`:
 *   1. the `CMUX_WORKSPACE_ID` UUID the relay server stamped into the session's
 *      port file (works for ANY cmux session, durable across bot restarts), else
 *   2. a workspace ref captured at /new spawn time (covers sessions whose relay
 *      predates workspace-id recording).
 * Returns null (never an empty ref — an empty `--workspace` makes `cmux send`
 * fall back to the *caller's own* surface).
 */
export async function resolveCmuxWorkspace(
  sctx: SessionContext,
  scan: () => Promise<PortFileData[]> = scanPortFiles,
): Promise<string | null> {
  try {
    const alive = await scan();
    // Exact session match first.
    const byId = selectRelayTarget(alive, {
      sessionId: sctx.sessionId,
      sessionDir: sctx.sessionDir,
      claudePid: sctx.sessionPid,
    });
    if (byId?.cmuxWorkspaceId) return byId.cmuxWorkspaceId;
    // selectRelayTarget short-circuits on a sessionId miss without trying cwd,
    // so do an explicit cwd fallback — recovers the durable workspace id when
    // the port file's sessionId has drifted (e.g. a /clear changed it). Gated
    // on a UNIQUE dir match carrying a workspace id, so a non-cmux session (no
    // cmuxWorkspaceId) or an ambiguous dir can never resolve to a wrong target.
    const dir = canonical(sctx.sessionDir);
    const byDir = alive.filter(
      (pf) => canonical(pf.cwd) === dir && pf.cmuxWorkspaceId,
    );
    if (byDir.length === 1) return byDir[0]!.cmuxWorkspaceId!;
  } catch (err) {
    debug(`inject: port-file scan failed: ${err}`);
  }
  return getCmuxWorkspace(sctx.sessionDir) ?? null;
}

/**
 * Type `text` into the session's terminal and submit it. `text` should be the
 * raw line (e.g. "/clear") with no trailing newline — each app appends its own
 * submit key.
 */
export async function sendKeysToSession(
  sctx: SessionContext,
  text: string,
): Promise<InjectResult> {
  // Route per-session: the terminal app is a global *default*, but each session
  // may run in a different app. Detect this session's actual host from its
  // process ancestry; fall back to the global setting when pid is unknown or
  // the host is unrecognised.
  const app =
    (sctx.sessionPid !== undefined
      ? detectTerminalApp(sctx.sessionPid)
      : undefined) ?? getTerminal();

  if (app === "cmux") {
    const ref = await resolveCmuxWorkspace(sctx);
    // Guard: never inject with an empty ref — cmux would target the bot's own
    // surface instead (the footgun behind an early self-inject).
    if (!ref) {
      return {
        ok: false,
        app,
        reason:
          "No cmux workspace on record for this session — restart it (or /new) so the relay records its workspace id.",
      };
    }
    const bin = resolveCmuxBin();
    if (!bin) return { ok: false, app, reason: "cmux CLI not found." };
    for (const argv of buildCmuxInjectArgvs(bin, ref, text)) {
      const r = Bun.spawnSync(argv);
      if (r.exitCode !== 0) {
        const err = (r.stderr ?? Buffer.alloc(0)).toString().trim();
        // Drop a possibly-stale spawn-registry ref so the next attempt is clean.
        cmuxWorkspaceByCwd.delete(canonical(sctx.sessionDir));
        return {
          ok: false,
          app,
          reason: `cmux send failed (${err || "workspace gone?"}).`,
        };
      }
    }
    return { ok: true, app };
  }

  if (app === "iterm2" || app === "terminal") {
    if (sctx.sessionPid === undefined) {
      return { ok: false, app, reason: "No pid known for this session." };
    }
    const ttys = ttyChainForPid(sctx.sessionPid);
    if (ttys.length === 0) {
      return { ok: false, app, reason: "Could not resolve the session's tty." };
    }
    const r = runOsascript(buildTtyWriteScript(app, ttys, text));
    if (!r.ok) {
      warn(`inject: osascript failed: ${r.stderr.slice(0, 200)}`);
      return {
        ok: false,
        app,
        reason: r.stderr.slice(0, 200) || "osascript failed.",
      };
    }
    // The script returns the number of tabs/sessions written to. 0 means no
    // live window had a matching tty (closed, or app mis-detected) — osascript
    // still exits 0, so without this check we'd falsely report success.
    if (Number(r.stdout) < 1) {
      return {
        ok: false,
        app,
        reason:
          "No matching terminal window/tab found for this session (was it closed?).",
      };
    }
    return { ok: true, app };
  }

  // ghostty — no API to target a specific window, so this keystrokes into
  // whatever Ghostty window is frontmost. Surface that it's best-effort rather
  // than report a verified send.
  const r = runOsascript(buildGhosttyKeystrokeScript(text));
  if (!r.ok) {
    return {
      ok: false,
      app,
      reason: r.stderr.slice(0, 200) || "System Events keystroke failed.",
    };
  }
  return {
    ok: true,
    app,
    note: "best-effort: sent to the frontmost Ghostty window",
  };
}
