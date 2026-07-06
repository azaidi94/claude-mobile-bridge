/**
 * Relay discovery — finds running channel-relay instances by scanning
 * STATE_DIR/channel-relay-*.json port files. Validates PID and caches clients.
 */

import { readFile, readdir, unlink } from "fs/promises";
import { readFileSync, writeFileSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { RelayClient } from "./client";
import { RELAY_CONNECT_TIMEOUT_MS } from "../config";
import { STATE_DIR, parseRelayPortFilePid } from "../paths";
import { debug, info, warn } from "../logger";
import { attachAskRemoteToRelay } from "../handlers/relay-ask";
import { shadowResolveSession } from "../sessions/identity-shadow";
import { getCurrentSnapshot, type Handle } from "../sessions/resolve-session";

export interface PortFileData {
  port: number;
  pid: number;
  ppid?: number;
  sessionId?: string;
  cwd: string;
  startedAt: string;
  /** Set by bot after watcher assigns a name. */
  sessionName?: string;
  /** Set by bot after Telegram forum topic is created (group setups only). */
  topicId?: number;
  /** Set by bot after Telegram forum topic is created (group setups only). */
  topicName?: string;
  /**
   * cmux workspace UUID, captured from the relay server's own environment
   * (cmux injects `CMUX_WORKSPACE_ID` into every surface shell, which the
   * claude process and its relay child inherit). Lets the bot inject slash
   * commands into ANY cmux session — not just bot-spawned ones — via
   * `cmux send --workspace <cmuxWorkspaceId>`. (Workspace, not surface:
   * `--surface` is rejected for `new-workspace --command` surfaces.) Absent on
   * non-cmux terminals.
   */
  cmuxWorkspaceId?: string;
  /**
   * tmux pane id (`%N`) the claude process runs in, captured from the relay
   * server's own environment (`$TMUX_PANE`, inherited from the tmux pane down
   * to the claude process and its relay child). Paired with `tmuxSocket`, it
   * lets the bot inject slash commands via `tmux -S <socket> send-keys -t
   * <pane>` — accessibility-free, focus-free, and terminal-agnostic (works in
   * Cursor, iTerm, Ghostty…). Absent when claude isn't running under tmux.
   */
  tmuxPane?: string;
  /** tmux socket path (first field of `$TMUX`), pairs with `tmuxPane`. */
  tmuxSocket?: string;
}

export interface RelaySelector {
  sessionId?: string;
  sessionDir?: string;
  claudePid?: number;
}

// Cached clients keyed by the strongest known identity for a relay.
const clientCache = new Map<
  string,
  { client: RelayClient; port: number; dir: string }
>();

// In-flight connects keyed by the same cache keys. Concurrent callers for the
// same target join the existing promise instead of creating duplicate
// connections. Entry is removed in finally() once the promise settles.
const inFlightConnects = new Map<string, Promise<RelayClient | null>>();

// TTL cache for port file scan results (avoids STATE_DIR readdir on every message)
const SCAN_TTL_MS = 5_000;
let lastScanResult: PortFileData[] = [];
let lastScanTime = 0;

// Test seam: integration tests can override the relay-process probe to
// bypass the `ps` check (their fake port files reference arbitrary PIDs).
// Production never calls setIsRelayProcessProbe — the default behaviour is
// the unmocked function below.
let _isRelayProcessProbe: (pid: number) => boolean = defaultIsRelayProcess;
function defaultIsRelayProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const cmd = execSync(`ps -p ${pid} -o command=`, {
      encoding: "utf-8",
    }).trim();
    return cmd.includes("channel-relay");
  } catch {
    return false;
  }
}

/**
 * Check if a PID is alive AND is actually a channel-relay process.
 * Prevents false positives from PID reuse.
 */
export function isRelayProcess(pid: number): boolean {
  return _isRelayProcessProbe(pid);
}

/** Test-only override. Pass `null` to restore the default. */
export function setIsRelayProcessProbe(
  probe: ((pid: number) => boolean) | null,
): void {
  _isRelayProcessProbe = probe ?? defaultIsRelayProcess;
}

/**
 * Raw PID liveness check (signal 0). For relay discovery, prefer
 * `isRelayProcess` — it also validates the process is actually channel-relay,
 * so PID reuse can't produce false positives.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function dirHash(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 12);
}

/**
 * Scan for relay port files. Results are cached with a short TTL.
 */
export async function scanPortFiles(force = false): Promise<PortFileData[]> {
  const now = Date.now();
  if (!force && now - lastScanTime < SCAN_TTL_MS) return lastScanResult;

  const results: PortFileData[] = [];
  try {
    const files = await readdir(STATE_DIR);
    for (const file of files) {
      if (!file.startsWith("channel-relay-") || !file.endsWith(".json"))
        continue;
      try {
        const filePath = join(STATE_DIR, file);
        const content = await readFile(filePath, "utf-8");
        const data = JSON.parse(content) as PortFileData;
        if (data.port && data.pid && data.cwd && isRelayProcess(data.pid)) {
          results.push(data);
        } else if (data.pid && !isProcessAlive(data.pid)) {
          // PID confirmed dead — safe to clean up stale port file.
          unlink(filePath).catch(() => {});
        } else if (data.pid) {
          // PID is alive but not recognized as a channel-relay process.
          // Don't delete — the relay may have restarted with a different
          // command line, or ps may have failed transiently.
          debug("relay: alive pid not recognized as channel-relay, skipping", {
            pid: data.pid,
            file: file,
          });
        }
      } catch {
        // Skip malformed files
      }
    }
  } catch {
    // STATE_DIR not readable
  }

  lastScanResult = results;
  lastScanTime = now;
  return results;
}

/** Invalidate the scan cache (called when watcher detects port file change). */
export function invalidateScanCache(): void {
  lastScanTime = 0;
}

/**
 * Merge `updates` into the relay's port file. Per-PID promise queue
 * serialises concurrent writers in the bot process so reads/writes don't
 * interleave (e.g., watcher's `sessionName` write racing topic-manager's
 * `topicId` write). No-ops on missing/malformed files.
 */
const updatePortFileQueue = new Map<number, Promise<void>>();

export function updatePortFile(
  relayPid: number,
  updates: Partial<PortFileData>,
  opts?: { preserveExisting?: (keyof PortFileData)[] },
): Promise<void> {
  const prev = updatePortFileQueue.get(relayPid) ?? Promise.resolve();
  const next = prev.then(() => doUpdatePortFile(relayPid, updates, opts));
  updatePortFileQueue.set(
    relayPid,
    next.finally(() => {
      if (updatePortFileQueue.get(relayPid) === next) {
        updatePortFileQueue.delete(relayPid);
      }
    }),
  );
  // Returning the queued promise lets startup/test paths (e.g.
  // backfillPortFileSessionIds) await the write before re-reading
  // the dir. Production call sites that don't care can ignore it.
  return next;
}

function doUpdatePortFile(
  relayPid: number,
  updates: Partial<PortFileData>,
  opts?: { preserveExisting?: (keyof PortFileData)[] },
): void {
  let targetFile: string | null = null;
  try {
    const files = readdirSync(STATE_DIR);
    for (const f of files) {
      if (parseRelayPortFilePid(f) === relayPid) {
        targetFile = join(STATE_DIR, f);
        break;
      }
    }
  } catch {
    return;
  }
  if (!targetFile) return;

  try {
    const raw = readFileSync(targetFile, "utf-8");
    const current = JSON.parse(raw) as PortFileData;
    // Drop any field the caller marked preserve-if-set that already holds a
    // truthy value on disk. This read+write is synchronous (no await gap), so
    // it atomically resolves the backfill-vs-hook race: the SessionStart hook's
    // authoritative sessionId, once written, is never overwritten by backfill's
    // later mtime-guessed id.
    const effective: Partial<PortFileData> = { ...updates };
    for (const k of opts?.preserveExisting ?? []) {
      if (current[k]) delete effective[k];
    }
    const merged = { ...current, ...effective };
    const tmpFile = `${targetFile}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(merged, null, 2));
    renameSync(tmpFile, targetFile);
    invalidateScanCache();
  } catch {
    // Malformed file or race — silently skip
  }
}

export async function isRelayAvailable(
  selector?: RelaySelector | string,
  claudePid?: number,
): Promise<boolean> {
  const client = await getRelayClient(selector, claudePid);
  return client !== null;
}

export async function getRelayClient(
  selector?: RelaySelector | string,
  claudePid?: number,
): Promise<RelayClient | null> {
  const relaySelector = normalizeRelaySelector(selector, claudePid);

  // Fast path: check cache before I/O
  const key = cacheKey(relaySelector);
  if (key) {
    const cached = clientCache.get(key);
    if (cached?.client.isConnected) return cached.client;
    if (cached) {
      cached.client.disconnect();
      clientCache.delete(key);
    }
  }

  const alive = await scanPortFiles();
  if (alive.length === 0) return null;

  const target = selectRelayTarget(alive, relaySelector);
  if (!target) return null;

  const targetKey =
    cacheKey({
      sessionId: target.sessionId,
      sessionDir: target.cwd,
      claudePid: target.ppid,
    }) || key;

  // Return cached client if connected at same port (covers no-sessionDir path)
  if (targetKey) {
    const cached = clientCache.get(targetKey);
    if (cached?.client.isConnected && cached.port === target.port) {
      return cached.client;
    }
    if (cached) {
      cached.client.disconnect();
      clientCache.delete(targetKey);
    }
  }

  // In-flight guard: if another caller is already connecting to this target,
  // join its promise instead of creating a duplicate connection.
  if (targetKey) {
    const inFlight = inFlightConnects.get(targetKey);
    if (inFlight) return inFlight;
  }

  // Connect
  const connectPromise = (async (): Promise<RelayClient | null> => {
    const client = new RelayClient();
    try {
      await client.connect(target.port);
      // Stamp session metadata on the client so listeners (relay-ask) can
      // route bus events by sessionName without a roundtrip lookup.
      client.sessionDir = target.cwd;
      try {
        const { getSessions } = await import("../sessions");
        const match = getSessions().find(
          (s) =>
            s.dir === target.cwd && (!target.ppid || s.pid === target.ppid),
        );
        client.sessionName = match?.name;
      } catch {
        // Sessions module may not be initialized in tests — best-effort lookup.
      }
      if (targetKey) {
        // Disconnect any existing cached entry before replacing it (defense
        // in depth — the in-flight guard should prevent concurrent
        // overwrites, but cache entries can also be replaced when a relay
        // restarts on a different port).
        const old = clientCache.get(targetKey);
        if (old) {
          old.client.disconnect();
        }
        clientCache.set(targetKey, {
          client,
          port: target.port,
          dir: target.cwd,
        });
      }
      // Subscribe the global ask_remote handler if the bot has registered
      // itself (initRelayAsk has been called). Safe to call before init:
      // it no-ops.
      attachAskRemoteToRelay(client);
      info("relay: connected", {
        cwd: target.cwd,
        relayPort: target.port,
        relayPid: target.pid,
        claudePid: target.ppid,
        sessionId: target.sessionId,
      });
      return client;
    } catch (err) {
      warn("relay: connect failed", err, {
        cwd: target.cwd,
        relayPort: target.port,
        relayPid: target.pid,
        claudePid: target.ppid,
        sessionId: target.sessionId,
      });
      return null;
    }
  })();

  if (targetKey) {
    inFlightConnects.set(targetKey, connectPromise);
  }
  try {
    return await connectPromise;
  } finally {
    if (targetKey && inFlightConnects.get(targetKey) === connectPromise) {
      inFlightConnects.delete(targetKey);
    }
  }
}

function normalizeRelaySelector(
  selector?: RelaySelector | string,
  claudePid?: number,
): RelaySelector {
  if (typeof selector === "string") {
    return { sessionDir: selector, claudePid };
  }
  return selector || {};
}

function cacheKey(selector: RelaySelector): string | null {
  if (selector.sessionId) return `session:${selector.sessionId}`;
  if (selector.sessionDir && selector.claudePid) {
    return `pid:${selector.sessionDir}\0${selector.claudePid}`;
  }
  if (selector.sessionDir) return `dir:${selector.sessionDir}`;
  return null;
}

function _selectRelayTargetImpl(
  alive: PortFileData[],
  selector: RelaySelector,
): PortFileData | null {
  if (selector.sessionId) {
    const bySessionId = alive.find((pf) => pf.sessionId === selector.sessionId);
    if (bySessionId) return bySessionId;
  }

  if (selector.claudePid) {
    const byPid = alive.find((pf) => pf.ppid === selector.claudePid);
    if (byPid) return byPid;
  }

  if (selector.sessionId) {
    warn("relay: no exact match for session", {
      sessionId: selector.sessionId,
      sessionDir: selector.sessionDir,
      claudePid: selector.claudePid,
    });
    return null;
  }

  if (selector.sessionDir) {
    const byDir = alive.filter((pf) => pf.cwd === selector.sessionDir);
    if (byDir.length === 1) return byDir[0]!;
    if (byDir.length > 1) {
      warn("relay: ambiguous selection", {
        sessionDir: selector.sessionDir,
        candidateCount: byDir.length,
      });
      return null;
    }
  }

  if (!selector.sessionId && !selector.sessionDir && !selector.claudePid) {
    return alive[0] || null;
  }

  return null;
}

/**
 * Shadow-instrumented wrapper (observe-only, no migration): delegates to
 * `_selectRelayTargetImpl` for the real, unchanged behavior, then reports the
 * chosen answer to `resolveSession` for comparison. Never affects the return
 * value — `shadowResolveSession` swallows its own errors.
 */
export function selectRelayTarget(
  alive: PortFileData[],
  selector: RelaySelector,
): PortFileData | null {
  const chosen = _selectRelayTargetImpl(alive, selector);

  const handle: Handle | null = selector.sessionId
    ? { by: "sessionId", sessionId: selector.sessionId }
    : selector.claudePid
      ? { by: "pid", pid: selector.claudePid }
      : selector.sessionDir
        ? { by: "cwd", cwd: selector.sessionDir }
        : null;

  if (handle) {
    shadowResolveSession(
      "selectRelayTarget",
      chosen?.sessionId ?? null,
      handle,
      getCurrentSnapshot(),
    );
  }

  return chosen;
}

export async function getRelayDirs(): Promise<string[]> {
  const alive = await scanPortFiles();
  return alive.map((pf) => pf.cwd);
}

/**
 * Disconnect the cached relay client for `selector`.
 *
 * Pass `sessionId` (or `claudePid`) when sessions share a dir — a dir-only
 * match would blow away sibling sessions' relays too. Silently no-ops if
 * no entry matches the selector's strongest key.
 */
export function disconnectRelay(selector: {
  sessionDir?: string;
  sessionId?: string;
  claudePid?: number;
}): void {
  const targetKey = cacheKey(selector);
  if (!targetKey) return;
  const entry = clientCache.get(targetKey);
  if (!entry) return;
  entry.client.disconnect();
  clientCache.delete(targetKey);
}

export function disconnectAllRelays(): void {
  for (const [, { client }] of clientCache) {
    client.disconnect();
  }
  clientCache.clear();
}
