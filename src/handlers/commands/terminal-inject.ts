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
  launchUuidForPid,
  launchUuidForSessionId,
} from "../../sessions/resolve-session";
import {
  scanPortFiles,
  selectRelayTarget,
  type PortFileData,
} from "../../relay";
import {
  capturePane,
  runTmux,
  tmuxBase,
  type TmuxTarget,
} from "../../tmux/exec";
import { isModalPresent, promptVisibleInPane } from "../../tmux/modal-detect";
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
  debug("inject: remembered cmux workspace", { ref, cwd });
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
  | {
      ok: false;
      app: TerminalApp;
      reason: string;
      /** The text never reached the input bar; nothing was sent. Render the pane + key panel. */
      blocked?: true;
      /** The pane as captured at refusal time — only set when `blocked`. */
      pane?: string;
      /** For building the key panel — only set when `blocked` and resolvable. */
      launchUuid?: string;
      /**
       * Headline for the blocked panel. Distinguishes a detected modal from
       * "not accepting input, no modal footer found" (`/usage` is the latter on
       * Claude Code 2.1.206). The renderer must not assert a dialog exists when
       * none was detected.
       */
      blockedHeadline?: string;
    };

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
 * The single alive port file that belongs to THIS session, selected by
 * `launchUuid`. The TARGET launchUuid is anchored on the AUTHORITATIVE registry
 * `sessionId → launchUuid` map (`uuidForSessionId`), which the hook re-anchors on
 * `/clear` independent of the port files — NOT on `sctx.sessionPid`, which the
 * watcher can itself mis-assign from a sibling's stolen-id port file
 * (`assignPidsToSessions` 2nd pass). The pid map (`uuidForPid`) is only a
 * fallback for the pre-hook window, and is what maps each port file's real
 * parent pid (`pf.ppid`) to its own launchUuid (that side is sound: `ppid` is
 * the real parent, and the pid map is registry-sourced on real claude pids).
 *
 * This is the injection twin of the topic cross-wire fix (Task 1c-a): a sibling
 * whose port file got stamped with this session's orphaned `sessionId` under
 * `/clear` churn cannot win here — only the port file whose real claude pid maps
 * to our `launchUuid` matches.
 *
 * Returns `undefined` when the session has no `launchUuid` (R1: Cursor
 * `source:"cursor"`, bare `claude`, offline/history — the snapshot has no entry)
 * OR no live port file maps to it — in both cases the caller falls back to the
 * existing `selectRelayTarget`/cwd path. Returns the matched port file even when
 * it carries no pane/workspace, so the caller can *refuse* rather than borrow a
 * sibling's target.
 */
function ownPortFileByLaunchUuid(
  sctx: SessionContext,
  alive: PortFileData[],
  uuidForPid: (pid?: number) => string | undefined,
  uuidForSessionId: (sessionId?: string) => string | undefined,
): PortFileData | undefined {
  const targetUuid =
    uuidForSessionId(sctx.sessionId) ?? uuidForPid(sctx.sessionPid);
  if (!targetUuid) return undefined; // R1: no launchUuid → caller uses old path
  const matches = alive.filter((pf) => uuidForPid(pf.ppid) === targetUuid);
  if (matches.length !== 1) return undefined; // 0 live, or (impossible) >1
  const pf = matches[0]!;
  // Soak signal: another live port file carrying our sessionId means a sibling
  // stole this session's id — the exact corruption launchUuid selection defeats.
  const stolen = alive.find(
    (o) => o !== pf && !!o.sessionId && o.sessionId === sctx.sessionId,
  );
  if (stolen)
    warn("inject: launchUuid overrides a sibling holding this session's id", {
      sessionId: sctx.sessionId,
      sessionPid: sctx.sessionPid,
    });
  return pf;
}

/**
 * Resolve which cmux workspace to inject into for `sctx`:
 *   1. the `CMUX_WORKSPACE_ID` UUID the relay server stamped into the session's
 *      port file (works for ANY cmux session, durable across bot restarts), else
 *   2. a workspace ref captured at /new spawn time (covers sessions whose relay
 *      predates workspace-id recording).
 * Returns null (never an empty ref — an empty `--workspace` makes `cmux send`
 * fall back to the *caller's own* surface).
 *
 * Selection is `launchUuid`-primary (`ownPortFileByLaunchUuid`); the
 * `selectRelayTarget`/cwd ladder below is the R1 fallback for sessions with no
 * launchUuid (Cursor/bare/offline). Kept deliberately as a dormant safety net —
 * P3 Task 5 "delete byDir" was dropped; hook-bearing sessions never reach it.
 */
export async function resolveCmuxWorkspace(
  sctx: SessionContext,
  scan: () => Promise<PortFileData[]> = scanPortFiles,
  uuidForPid: (pid?: number) => string | undefined = launchUuidForPid,
  uuidForSessionId: (
    sessionId?: string,
  ) => string | undefined = launchUuidForSessionId,
): Promise<string | null> {
  try {
    const alive = await scan();
    // launchUuid-primary: our own port file, id-corruption-safe.
    const own = ownPortFileByLaunchUuid(
      sctx,
      alive,
      uuidForPid,
      uuidForSessionId,
    );
    if (own) {
      if (own.cmuxWorkspaceId) return own.cmuxWorkspaceId;
      // Our own port file has no workspace id. The spawn-registry is cwd-keyed
      // (the last /new spawn in a dir overwrites it), so it may hold a sibling's
      // ref — trust it ONLY when this session is alone in its cwd; a same-cwd
      // sibling makes it ambiguous → refuse rather than risk the wrong surface.
      const dir = canonical(sctx.sessionDir);
      const hasSibling = alive.some(
        (pf) => pf !== own && canonical(pf.cwd) === dir,
      );
      return hasSibling ? null : (getCmuxWorkspace(sctx.sessionDir) ?? null);
    }
    // R1 fallback: exact session match first.
    const byId = selectRelayTarget(alive, {
      sessionId: sctx.sessionId,
      sessionDir: sctx.sessionDir,
      claudePid: sctx.sessionPid,
    });
    if (byId) {
      // Positive identity (matched by sessionId or pid): trust ONLY this
      // session's own workspace id. If it has none, don't scan the live port
      // files by cwd — that could grab a same-cwd sibling's workspace. Fall
      // through to the spawn-registry, which is this bot's own record for the
      // dir (covers sessions whose relay predates workspace-id recording).
      if (byId.cmuxWorkspaceId) return byId.cmuxWorkspaceId;
    } else {
      // byId is null → selectRelayTarget short-circuited on a sessionId miss
      // (e.g. a /clear changed the id). Recover the durable workspace id via a
      // UNIQUE same-cwd live match; an ambiguous dir resolves to null so
      // siblings never mis-target.
      const dir = canonical(sctx.sessionDir);
      const byDir = alive.filter(
        (pf) => canonical(pf.cwd) === dir && pf.cmuxWorkspaceId,
      );
      if (byDir.length === 1) {
        // Tripwire: a hook-bearing match reaching this legacy cwd recovery means
        // the launchUuid path (ownPortFileByLaunchUuid) missed — likely a bug.
        if (launchUuidForPid(byDir[0]!.ppid))
          warn(
            "inject: cmux byDir fallback matched a HOOK-BEARING session — launchUuid path missed; likely a bug",
            { sessionDir: sctx.sessionDir, claudePid: byDir[0]!.ppid },
          );
        return byDir[0]!.cmuxWorkspaceId!;
      }
    }
  } catch (err) {
    debug("inject: port-file scan failed", { err: String(err) });
  }
  return getCmuxWorkspace(sctx.sessionDir) ?? null;
}

/** A tmux injection target: the pane id, and the socket path if non-default. */
export type { TmuxTarget };

/**
 * Resolve the tmux pane (+ socket) for `sctx` from the relay port files, or null
 * if the session isn't running under tmux. Mirrors `resolveCmuxWorkspace`:
 * `launchUuid`-primary (`ownPortFileByLaunchUuid`, id-corruption-safe), then the
 * R1 fallback — exact-sessionId match, then a UNIQUE same-cwd match carrying a
 * pane (so a drifted sessionId still resolves, but ambiguous siblings never
 * mis-target). The cwd fallback is a dormant safety net, kept deliberately
 * (P3 Task 5 dropped) — hook-bearing sessions resolve by launchUuid above.
 */
export async function resolveTmuxTarget(
  sctx: SessionContext,
  scan: () => Promise<PortFileData[]> = scanPortFiles,
  uuidForPid: (pid?: number) => string | undefined = launchUuidForPid,
  uuidForSessionId: (
    sessionId?: string,
  ) => string | undefined = launchUuidForSessionId,
): Promise<TmuxTarget | null> {
  try {
    const alive = await scan();
    // launchUuid-primary: our own port file, id-corruption-safe. When matched,
    // trust ONLY its pane — refuse (null) rather than borrow a sibling's if it
    // carries none (this session is genuinely not under tmux).
    const own = ownPortFileByLaunchUuid(
      sctx,
      alive,
      uuidForPid,
      uuidForSessionId,
    );
    if (own)
      return own.tmuxPane
        ? { pane: own.tmuxPane, socket: own.tmuxSocket }
        : null;
    // R1 fallback (no launchUuid): the existing selectRelayTarget + cwd ladder.
    const byId = selectRelayTarget(alive, {
      sessionId: sctx.sessionId,
      sessionDir: sctx.sessionDir,
      claudePid: sctx.sessionPid,
    });
    // Positive identity (matched by sessionId or pid): trust ONLY this session's
    // own pane. If it has none, this session is genuinely not under tmux — refuse
    // rather than fall through to the cwd scan, which could grab a same-cwd
    // sibling's pane and type into the wrong terminal.
    if (byId)
      return byId.tmuxPane
        ? { pane: byId.tmuxPane, socket: byId.tmuxSocket }
        : null;
    // byId is null → the port file's sessionId drifted (e.g. a /clear changed
    // it). Recover via a UNIQUE same-cwd match carrying a pane; an ambiguous dir
    // resolves to null so siblings never mis-target.
    const dir = canonical(sctx.sessionDir);
    const byDir = alive.filter(
      (pf) => canonical(pf.cwd) === dir && pf.tmuxPane,
    );
    if (byDir.length === 1) {
      // Tripwire: a hook-bearing match reaching this legacy cwd recovery means
      // the launchUuid path (ownPortFileByLaunchUuid) missed — likely a bug.
      if (launchUuidForPid(byDir[0]!.ppid))
        warn(
          "inject: tmux byDir fallback matched a HOOK-BEARING session — launchUuid path missed; likely a bug",
          { sessionDir: sctx.sessionDir, claudePid: byDir[0]!.ppid },
        );
      return { pane: byDir[0]!.tmuxPane!, socket: byDir[0]!.tmuxSocket };
    }
  } catch (err) {
    debug("inject: tmux target scan failed", { err: String(err) });
  }
  return null;
}

/** See tmux.ts — same measured value, same reason. */
const SEND_KEYS_SETTLE_MS = 500;

/**
 * Decide whether Enter is safe. Pure.
 *
 * `send-keys -l` into a modal is a NO-OP, so probing costs nothing in the bad
 * case. If our text is not visible in the input bar afterwards, a modal ate it —
 * and a bare Enter would CONFIRM that modal's highlighted item.
 */
export function planGuardedSend(
  before: string,
  after: string,
  text: string,
): { sendEnter: boolean } {
  return { sendEnter: promptVisibleInPane(before, after, text) };
}

/** The IO `sendKeysToTmux` performs. Injected so the guard is testable. */
export interface TmuxSendIO {
  capture: (target: TmuxTarget) => string;
  /** `keys` are the send-keys args after `-t <pane>` — e.g. `["-l", "/clear"]`. */
  send: (target: TmuxTarget, keys: string[]) => { ok: boolean; stderr: string };
  /** Render settle between typing and re-capture. 0 in tests. */
  settleMs?: number;
}

const liveTmuxIO: TmuxSendIO = {
  capture: capturePane,
  send: (target, keys) =>
    runTmux([...tmuxBase(target), "send-keys", "-t", target.pane, ...keys]),
};

/**
 * Type `text` into a tmux pane and submit it — but only once the pane proves it
 * accepted the text. `-l` sends the text literally so a leading `/` and special
 * chars aren't parsed as key names; `Enter` is a separate send-keys so it's
 * interpreted as the Return key.
 *
 * The Enter is the dangerous half: with a dialog up, the literal text is a no-op
 * and a bare Enter confirms the dialog's highlighted item (`1. Yes` on the Bash
 * permission prompt). So we capture, type, settle, re-capture, and press Enter
 * only when the text is demonstrably in the input bar. An empty capture — wedged
 * tmux, dead pane, missing binary — reads as UNKNOWN and fails closed.
 */
export async function sendKeysToTmux(
  target: TmuxTarget,
  text: string,
  launchUuid: string | undefined,
  io: TmuxSendIO = liveTmuxIO,
): Promise<InjectResult> {
  const before = io.capture(target);

  // Harmless if a modal is up: it is a no-op.
  const typed = io.send(target, ["-l", text]);
  if (!typed.ok) {
    return {
      ok: false,
      app: "tmux",
      reason: `tmux send-keys failed (${typed.stderr || "pane gone?"}).`,
    };
  }

  await Bun.sleep(io.settleMs ?? SEND_KEYS_SETTLE_MS);
  const after = io.capture(target);

  // TOCTOU note: a modal that pops DURING this settle is caught — the re-capture
  // below sees no framed input bar, `promptVisibleInPane` returns false, and we
  // refuse. A modal that pops AFTER the re-capture but BEFORE the `Enter`
  // send-keys below reaches tmux is NOT detectable by any capture-based design:
  // that window is one send-keys round-trip (single-digit ms) versus this
  // `SEND_KEYS_SETTLE_MS` (500ms) settle. That is an accepted, inherent
  // limitation of the guard, not a bug to fix here.
  if (!planGuardedSend(before, after, text).sendEnter) {
    if (!after) {
      // Capture itself failed (wedged tmux, missing binary, 5s timeout) — we
      // cannot tell whether a modal is up at all. Don't claim "blocked on a
      // dialog"; that sends the user hunting for a dialog that may not exist.
      return {
        ok: false,
        app: "tmux",
        reason:
          "couldn't read the session's screen (tmux not responding), so nothing was sent",
      };
    }
    if (isModalPresent(after)) {
      return {
        ok: false,
        app: "tmux",
        blocked: true,
        pane: after,
        launchUuid,
        blockedHeadline: "Session is blocked on a dialog.",
        reason: "the session is blocked on a dialog, so nothing was sent",
      };
    }
    // Text didn't land but no modal footer is detectable (e.g. `/usage`, which
    // blocks input yet has no capital-E footer token). Still refuse, but say
    // so honestly — the pane + key panel are still a useful fallback.
    return {
      ok: false,
      app: "tmux",
      blocked: true,
      pane: after,
      launchUuid,
      blockedHeadline: "Session isn't accepting input (no dialog detected).",
      reason:
        "the session isn't accepting input (nothing was sent) — here's its screen",
    };
  }

  const submitted = io.send(target, ["Enter"]);
  if (!submitted.ok) {
    return {
      ok: false,
      app: "tmux",
      reason: `tmux send-keys failed (${submitted.stderr || "pane gone?"}).`,
    };
  }
  return { ok: true, app: "tmux", note: `sent to tmux pane ${target.pane}` };
}

/**
 * Default chord for focusing the Cursor integrated terminal before injecting.
 * The user must bind THIS chord to `workbench.action.terminal.focus` in Cursor's
 * keybindings.json for the focus guard to work; override via CURSOR_FOCUS_CHORD.
 * Unbound → the chord is a harmless no-op and inject falls back to best-effort.
 */
const DEFAULT_CURSOR_FOCUS_CHORD = "ctrl+alt+cmd+t";

/**
 * Count how many live relay (Claude Code) sessions share `dir` as their cwd.
 * Used to gate Cursor injection: same-folder siblings live as indistinguishable
 * tabs in one Cursor window (identical titles, no pid→tab mapping), so we refuse
 * rather than risk injecting into the wrong one.
 *
 * Intentionally counts ALL cwd-sharing sessions, not just Cursor-hosted ones: a
 * non-Cursor sibling (iTerm/tmux) in the same cwd will still make Cursor injection
 * refuse. That's over-conservative (the window-title match would be unambiguous)
 * but fails closed, which is the right trade for a "type into whatever's focused" path.
 */
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
    warn("inject: cursor osascript failed", {
      stderr: r.stderr.slice(0, 200),
      session: sctx.sessionName,
    });
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
    return await sendKeysToTmux(
      tmux,
      text,
      launchUuidForSessionId(sctx.sessionId),
    );
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
      warn("inject: osascript failed", {
        stderr: r.stderr.slice(0, 200),
        session: sctx.sessionName,
      });
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
