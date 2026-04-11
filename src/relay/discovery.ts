/**
 * Relay discovery — finds running channel-relay instances by scanning
 * /tmp/channel-relay-*.json port files. Validates PID and caches clients.
 */

import { readFile, readdir, unlink } from "fs/promises";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { RelayClient } from "./client";
import { RELAY_CONNECT_TIMEOUT_MS } from "../config";
import { debug, info, warn } from "../logger";

export interface PortFileData {
  port: number;
  pid: number;
  ppid?: number;
  sessionId?: string;
  cwd: string;
  startedAt: string;
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

// TTL cache for port file scan results (avoids /tmp readdir on every message)
const SCAN_TTL_MS = 5_000;
let lastScanResult: PortFileData[] = [];
let lastScanTime = 0;

/**
 * Check if a PID is alive AND is actually a channel-relay process.
 * Prevents false positives from PID reuse.
 */
export function isRelayProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // Verify the process is actually channel-relay, not a reused PID
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
    const files = await readdir("/tmp");
    for (const file of files) {
      if (!file.startsWith("channel-relay-") || !file.endsWith(".json"))
        continue;
      try {
        const filePath = `/tmp/${file}`;
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
    // /tmp not readable
  }

  lastScanResult = results;
  lastScanTime = now;
  return results;
}

/** Invalidate the scan cache (called when watcher detects port file change). */
export function invalidateScanCache(): void {
  lastScanTime = 0;
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
    if (targetKey) {
      clientCache.set(targetKey, {
        client,
        port: target.port,
        dir: target.cwd,
      });
    }
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

export function disconnectRelay(sessionDir: string): void {
  for (const [key, { client }] of clientCache) {
    const entry = clientCache.get(key);
    if (!entry) continue;
    if (entry.dir === sessionDir) {
      client.disconnect();
      clientCache.delete(key);
    }
  }
}

export function disconnectAllRelays(): void {
  for (const [, { client }] of clientCache) {
    client.disconnect();
  }
  clientCache.clear();
}
