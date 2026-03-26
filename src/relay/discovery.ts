/**
 * Relay discovery — finds running channel-relay instances by scanning
 * /tmp/channel-relay-*.json port files. Validates PID and caches clients.
 */

import { readFile, readdir, unlink } from "fs/promises";
import { createHash } from "crypto";
import { RelayClient } from "./client";
import { RELAY_CONNECT_TIMEOUT_MS } from "../config";
import { debug, info } from "../logger";

export interface PortFileData {
  port: number;
  pid: number;
  cwd: string;
  startedAt: string;
}

// Cached clients keyed by cwd
const clientCache = new Map<string, { client: RelayClient; port: number }>();

// TTL cache for port file scan results (avoids /tmp readdir on every message)
const SCAN_TTL_MS = 5_000;
let lastScanResult: PortFileData[] = [];
let lastScanTime = 0;

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
        const content = await readFile(`/tmp/${file}`, "utf-8");
        const data = JSON.parse(content) as PortFileData;
        if (data.port && data.pid && data.cwd && isProcessAlive(data.pid)) {
          results.push(data);
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
): Promise<RelayClient | null> {
  // Check cache first — fast path, no I/O
  if (sessionDir) {
    const cached = clientCache.get(sessionDir);
    if (cached?.client.isConnected) return cached.client;
    if (cached) {
      cached.client.disconnect();
      clientCache.delete(sessionDir);
    }
  }

  const alive = await scanPortFiles();
  if (alive.length === 0) return null;

  // Find matching relay
  const target = sessionDir
    ? alive.find((pf) => pf.cwd === sessionDir)
    : alive[0];
  if (!target) return null;

  // Check if already connected at same port
  const cached = clientCache.get(target.cwd);
  if (cached?.client.isConnected && cached.port === target.port) {
    return cached.client;
  }
  if (cached) {
    cached.client.disconnect();
    clientCache.delete(target.cwd);
  }

  // Connect
  const client = new RelayClient();
  try {
    await client.connect(target.port);
    clientCache.set(target.cwd, { client, port: target.port });
    info(`relay: connected to ${target.cwd} on port ${target.port}`);
    return client;
  } catch (err) {
    debug(`relay: connect failed for ${target.cwd}: ${err}`);
    return null;
  }
}

export async function getRelayDirs(): Promise<string[]> {
  const alive = await scanPortFiles();
  return alive.map((pf) => pf.cwd);
}

export function disconnectRelay(sessionDir: string): void {
  const cached = clientCache.get(sessionDir);
  if (cached) {
    cached.client.disconnect();
    clientCache.delete(sessionDir);
  }
}

export function disconnectAllRelays(): void {
  for (const [, { client }] of clientCache) {
    client.disconnect();
  }
  clientCache.clear();
}
