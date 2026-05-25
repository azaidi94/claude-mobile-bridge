/**
 * Relay discovery — finds running channel-relay instances by scanning
 * STATE_DIR/channel-relay-*.json port files. Validates PID and caches clients.
 */

import { readFile, readdir, unlink } from "fs/promises";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { RelayClient } from "./client";
import { RELAY_CONNECT_TIMEOUT_MS } from "../config";
import { STATE_DIR, parseRelayPortFilePid } from "../paths";
import { debug, info, warn } from "../logger";
import { attachAskRemoteToRelay } from "../handlers/relay-ask";

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
        } else if (data.pid && !isRelayProcess(data.pid)) {
          // Clean up stale port file (dead or PID-reused process)
          unlink(filePath).catch(() => {});
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
): void {
  const prev = updatePortFileQueue.get(relayPid) ?? Promise.resolve();
  const next = prev.then(() => doUpdatePortFile(relayPid, updates));
  updatePortFileQueue.set(
    relayPid,
    next.finally(() => {
      if (updatePortFileQueue.get(relayPid) === next) {
        updatePortFileQueue.delete(relayPid);
      }
    }),
  );
}

function doUpdatePortFile(
  relayPid: number,
  updates: Partial<PortFileData>,
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
    const merged = { ...current, ...updates };
    writeFileSync(targetFile, JSON.stringify(merged, null, 2));
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

  // Connect
  const client = new RelayClient();
  try {
    await client.connect(target.port);
    // Stamp session metadata on the client so listeners (relay-ask) can
    // route bus events by sessionName without a roundtrip lookup.
    client.sessionDir = target.cwd;
    try {
      const { getSessions } = await import("../sessions");
      const match = getSessions().find(
        (s) => s.dir === target.cwd && (!target.ppid || s.pid === target.ppid),
      );
      client.sessionName = match?.name;
    } catch {
      // Sessions module may not be initialized in tests — best-effort lookup.
    }
    if (targetKey) {
      clientCache.set(targetKey, {
        client,
        port: target.port,
        dir: target.cwd,
      });
    }
    // Subscribe the global ask_remote handler if the bot has registered itself
    // (initRelayAsk has been called). Safe to call before init: it no-ops.
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

export function selectRelayTarget(
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
