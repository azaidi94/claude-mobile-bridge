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
import { basename } from "path";
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

/** A keystroke chord parsed into AppleScript form: a key + System Events modifiers. */
export interface ParsedChord {
  key: string;
  /** e.g. ["control down", "option down", "command down"] */
  modifiers: string[];
}

/**
 * Parse a chord like "ctrl+alt+cmd+t" into a key + AppleScript modifier list.
 * Returns null for empty/keyless input (caller then skips the focus step).
 */
export function parseChord(raw: string | undefined): ParsedChord | null {
  if (!raw) return null;
  const parts = raw
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1]!;
  const mods: string[] = [];
  for (const p of parts.slice(0, -1)) {
    if (p === "ctrl" || p === "control") mods.push("control down");
    else if (p === "alt" || p === "opt" || p === "option")
      mods.push("option down");
    else if (p === "cmd" || p === "command" || p === "meta")
      mods.push("command down");
    else if (p === "shift") mods.push("shift down");
  }
  if (!key || key.length === 0) return null;
  return { key, modifiers: mods };
}

/**
 * Build the System Events script that types `text` into the Cursor integrated
 * terminal for the session whose workspace folder basename is `folderName`.
 *
 * Cursor can't be driven like iTerm2/Terminal (xterm.js, no tty-targeted
 * AppleScript, no send-to-terminal CLI). And its terminal is a canvas, so it's
 * NOT exposed as an accessibility element unless focused + in screen-reader
 * mode — we can't locate it via AX. Instead we target the *window* by its title
 * (`… — <folderName>`), raise it, and rely on keystrokes going to whatever is
 * focused. To make "whatever is focused" reliably be the terminal (not an
 * editor, and to reveal a hidden panel), we first send `focusChord` — a chord
 * the user binds to `workbench.action.terminal.focus` in Cursor. Without that
 * binding the chord is a harmless no-op and this degrades to best-effort (works
 * only when the terminal already has focus).
 *
 * Window targeting is reliable ONLY when the folder hosts a single session —
 * the caller must gate on that first. Returns a sentinel:
 *   OK | ERR_NO_CURSOR | ERR_NO_WINDOW | ERR_MULTI_WINDOW | ERR_RAISE_FAILED |
 *   ERR_NOT_TERMINAL_FOCUSED
 *
 * TWO safety gates, both types-nothing-on-failure (a clean refusal always beats
 * a mis-injection): (1) the raised window must be frontmost; (2) after the focus
 * chord, the process's focused UI element must be a terminal (its description
 * starts with "Terminal ") — an editor reports "The editor is not accessible…",
 * so if the chord is unbound and an editor has focus we refuse instead of typing
 * `/clear` into a source file. `submit` appends Return (false = leave text
 * unsent, used by the non-destructive smoke test).
 */
export function buildCursorInjectScript(
  folderName: string,
  text: string,
  opts: { submit?: boolean; focusChord?: ParsedChord | null } = {},
): string {
  const { submit = true, focusChord = null } = opts;
  const f = escapeAppleScriptDoubleQuoted(folderName);
  const t = escapeAppleScriptDoubleQuoted(text);
  const focusLines =
    focusChord && focusChord.key
      ? [
          `    keystroke "${escapeAppleScriptDoubleQuoted(focusChord.key)}"${
            focusChord.modifiers.length
              ? ` using {${focusChord.modifiers.join(", ")}}`
              : ""
          }`,
          `    delay 0.2`,
        ]
      : [];
  return [
    `tell application "System Events"`,
    `  if not (exists process "Cursor") then return "ERR_NO_CURSOR"`,
    `  tell process "Cursor"`,
    `    set matches to {}`,
    `    repeat with w in windows`,
    `      try`,
    `        if (name of w) ends with "${f}" then set end of matches to w`,
    `      end try`,
    `    end repeat`,
    `    if (count of matches) is 0 then return "ERR_NO_WINDOW"`,
    `    if (count of matches) > 1 then return "ERR_MULTI_WINDOW"`,
    `    set frontmost to true`,
    `    perform action "AXRaise" of (item 1 of matches)`,
    `    delay 0.3`,
    `    set fw to window 1`,
    `    set okFront to false`,
    `    try`,
    `      if (name of fw) ends with "${f}" then set okFront to true`,
    `    end try`,
    `    if not okFront then return "ERR_RAISE_FAILED"`,
    ...focusLines,
    // Safety gate: only type if a terminal actually holds keyboard focus.
    `    set focDesc to ""`,
    `    try`,
    `      set focDesc to description of (value of attribute "AXFocusedUIElement")`,
    `    end try`,
    `    if focDesc does not start with "Terminal " then return "ERR_NOT_TERMINAL_FOCUSED"`,
    `    keystroke "${t}"`,
    ...(submit ? [`    key code 36`] : []),
    `  end tell`,
    `end tell`,
    `return "OK"`,
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
    // Cursor hosts the session in its integrated terminal; its ancestry runs
    // through `Cursor Helper: terminal pty-host` → `…/Cursor.app/…/Cursor`,
    // both of which lowercase-contain "cursor". Match before the generic
    // Terminal.app check (nothing else contains "cursor", so order is safe).
    if (c.includes("cursor")) return "cursor";
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

/** A tmux injection target: the pane id, and the socket path if non-default. */
export interface TmuxTarget {
  pane: string;
  socket?: string;
}

/**
 * Resolve the tmux pane (+ socket) for `sctx` from the relay port files, or null
 * if the session isn't running under tmux. Mirrors `resolveCmuxWorkspace`:
 * exact-sessionId match first, then a UNIQUE same-cwd match carrying a pane (so
 * a drifted sessionId still resolves, but ambiguous siblings never mis-target).
 */
export async function resolveTmuxTarget(
  sctx: SessionContext,
  scan: () => Promise<PortFileData[]> = scanPortFiles,
): Promise<TmuxTarget | null> {
  try {
    const alive = await scan();
    const byId = selectRelayTarget(alive, {
      sessionId: sctx.sessionId,
      sessionDir: sctx.sessionDir,
      claudePid: sctx.sessionPid,
    });
    if (byId?.tmuxPane) return { pane: byId.tmuxPane, socket: byId.tmuxSocket };
    const dir = canonical(sctx.sessionDir);
    const byDir = alive.filter(
      (pf) => canonical(pf.cwd) === dir && pf.tmuxPane,
    );
    if (byDir.length === 1)
      return { pane: byDir[0]!.tmuxPane!, socket: byDir[0]!.tmuxSocket };
  } catch (err) {
    debug(`inject: tmux target scan failed: ${err}`);
  }
  return null;
}

/**
 * Two argv batches to type `text` then submit it in a tmux pane. `-l` sends the
 * text literally so a leading `/` and special chars aren't parsed as key names;
 * `Enter` is a separate send-keys so it's interpreted as the Return key.
 */
export function buildTmuxSendArgs(
  target: TmuxTarget,
  text: string,
): string[][] {
  const base = target.socket ? ["tmux", "-S", target.socket] : ["tmux"];
  return [
    [...base, "send-keys", "-t", target.pane, "-l", text],
    [...base, "send-keys", "-t", target.pane, "Enter"],
  ];
}

/**
 * Count how many live relay (Claude Code) sessions share `dir` as their cwd.
 * Used to gate Cursor injection: same-folder siblings live as indistinguishable
 * tabs in one Cursor window (identical titles, no pid→tab mapping), so we refuse
 * rather than risk injecting into the wrong one.
 */
/**
 * Default chord for focusing the Cursor integrated terminal before injecting.
 * The user must bind THIS chord to `workbench.action.terminal.focus` in Cursor's
 * keybindings.json for the focus guard to work; override via CURSOR_FOCUS_CHORD.
 * Unbound → the chord is a harmless no-op and inject falls back to best-effort.
 */
const DEFAULT_CURSOR_FOCUS_CHORD = "ctrl+alt+cmd+t";

export async function countSessionsInDir(
  dir: string,
  scan: () => Promise<PortFileData[]> = scanPortFiles,
): Promise<number> {
  const canon = canonical(dir);
  try {
    const files = await scan();
    return files.filter((pf) => canonical(pf.cwd) === canon).length;
  } catch {
    // Scan failure → treat as "unknown, not provably safe": report >1 so the
    // caller refuses rather than risk a mis-targeted inject.
    return 2;
  }
}

/**
 * Inject `text` into a Cursor-hosted session's integrated terminal. Only works
 * when the session is the sole occupant of its workspace folder (so the window
 * title uniquely identifies it); otherwise refuses with a clear message. See
 * `buildCursorInjectScript` for the targeting/safety mechanism.
 */
async function injectIntoCursor(
  sctx: SessionContext,
  text: string,
): Promise<InjectResult> {
  const app: TerminalApp = "cursor";
  const folder = basename(canonical(sctx.sessionDir));

  const siblings = await countSessionsInDir(sctx.sessionDir);
  if (siblings > 1) {
    return {
      ok: false,
      app,
      reason: `${siblings} Claude sessions share this Cursor folder — can't target one. Run the command in the tab.`,
    };
  }

  const focusChord = parseChord(
    process.env.CURSOR_FOCUS_CHORD ?? DEFAULT_CURSOR_FOCUS_CHORD,
  );
  const r = runOsascript(buildCursorInjectScript(folder, text, { focusChord }));
  if (!r.ok) {
    warn(`inject: cursor osascript failed: ${r.stderr.slice(0, 200)}`);
    return {
      ok: false,
      app,
      reason: r.stderr.slice(0, 200) || "osascript failed.",
    };
  }
  switch (r.stdout.trim()) {
    case "OK":
      return {
        ok: true,
        app,
        note: `best-effort: sent to the Cursor window for "${folder}"`,
      };
    case "ERR_NO_CURSOR":
      return { ok: false, app, reason: "Cursor isn't running." };
    case "ERR_NO_WINDOW":
      return {
        ok: false,
        app,
        reason: `No Cursor window found for "${folder}" — is it open?`,
      };
    case "ERR_MULTI_WINDOW":
      return {
        ok: false,
        app,
        reason: `Multiple Cursor windows match "${folder}" — can't safely pick one.`,
      };
    case "ERR_RAISE_FAILED":
      return {
        ok: false,
        app,
        reason: `Couldn't bring the "${folder}" Cursor window to the front.`,
      };
    case "ERR_NOT_TERMINAL_FOCUSED":
      return {
        ok: false,
        app,
        reason: `Couldn't focus the terminal in the "${folder}" Cursor window (an editor had focus). Bind ${DEFAULT_CURSOR_FOCUS_CHORD} to "workbench.action.terminal.focus" in Cursor, or click the terminal, then retry.`,
      };
    default:
      return {
        ok: false,
        app,
        reason: r.stdout.trim()
          ? `Unexpected Cursor response: ${r.stdout.trim().slice(0, 120)}`
          : "No response from Cursor.",
      };
  }
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
  // Preferred path: if the session runs under tmux, inject via `tmux send-keys`.
  // It's accessibility- and focus-free and terminal-agnostic (works in Cursor,
  // iTerm, Ghostty…), so it wins over every host-specific fallback below.
  const tmux = await resolveTmuxTarget(sctx);
  if (tmux) {
    for (const argv of buildTmuxSendArgs(tmux, text)) {
      const r = Bun.spawnSync(argv);
      if (r.exitCode !== 0) {
        const err = (r.stderr ?? Buffer.alloc(0)).toString().trim();
        return {
          ok: false,
          app: "tmux",
          reason: `tmux send-keys failed (${err || "pane gone?"}).`,
        };
      }
    }
    return { ok: true, app: "tmux", note: `sent to tmux pane ${tmux.pane}` };
  }

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

  if (app === "cursor") {
    return await injectIntoCursor(sctx, text);
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
