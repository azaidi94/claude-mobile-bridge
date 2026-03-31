/**
 * Relay discovery — finds running channel-relay instances by scanning
 * /tmp/channel-relay-*.json port files. Validates PID and caches clients.
 */

import { readFile, readdir, unlink } from "fs/promises";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { RelayClient } from "./client";
import { RELAY_CONNECT_TIMEOUT_MS } from "../config";
import { debug, info } from "../logger";

export interface PortFileData {
  port: number;
  pid: number;
  ppid?: number;
  cwd: string;
  startedAt: string;
}

// Cached clients keyed by cwd
const clientCache = new Map<string, { client: RelayClient; port: number }>();

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
    const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8" }).trim();
    return cmd.includes("channel-relay");
  } catch {
    return false;
  }
}

/** @deprecated Use isRelayProcess instead */
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
export async function scanPortFiles(
  force = false,
): Promise<PortFileData[]> {
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
  sessionDir?: string,
): Promise<boolean> {
  const client = await getRelayClient(sessionDir);
  return client !== null;
}

export async function getRelayClient(
  sessionDir?: string,
  claudePid?: number,
): Promise<RelayClient | null> {
  // Fast path: check cache before I/O
  if (sessionDir) {
    const key = cacheKey(sessionDir, claudePid);
    const cached = clientCache.get(key);
    if (cached?.client.isConnected) return cached.client;
    if (cached) {
      cached.client.disconnect();
      clientCache.delete(key);
    }
  }

  const alive = await scanPortFiles();
  if (alive.length === 0) return null;

  // Find matching relay — ppid is authoritative, cwd may differ (e.g. worktrees)
  let target: PortFileData | undefined;
  if (claudePid) {
    target = alive.find((pf) => pf.ppid === claudePid);
  }
  if (!target && sessionDir) {
    target = alive.find((pf) => pf.cwd === sessionDir);
  }
  if (!target && !sessionDir && !claudePid) {
    target = alive[0];
  }
  if (!target) return null;

  const key = cacheKey(target.cwd, claudePid);

  // Return cached client if connected at same port (covers no-sessionDir path)
  const cached = clientCache.get(key);
  if (cached?.client.isConnected && cached.port === target.port) {
    return cached.client;
  }
  if (cached) {
    cached.client.disconnect();
    clientCache.delete(key);
  }

  // Connect
  const client = new RelayClient();
  try {
    await client.connect(target.port);
    clientCache.set(key, { client, port: target.port });
    info(`relay: connected to ${target.cwd} on port ${target.port} (ppid=${target.ppid || "?"})`);
    return client;
  } catch (err) {
    debug(`relay: connect failed for ${target.cwd}: ${err}`);
    return null;
  }
}

function cacheKey(dir: string, pid?: number): string {
  return pid ? `${dir}\0${pid}` : dir;
}

export async function getRelayDirs(): Promise<string[]> {
  const alive = await scanPortFiles();
  return alive.map((pf) => pf.cwd);
}

export function disconnectRelay(sessionDir: string): void {
  for (const [key, { client }] of clientCache) {
    if (key === sessionDir || key.startsWith(`${sessionDir}\0`)) {
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
