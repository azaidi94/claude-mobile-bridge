/**
 * Port-file sessionId backfill — runs once at bot startup.
 *
 * Older relay processes (or ones that hit a discovery-loop race we've since
 * patched) leave their port file without a `sessionId`. Without it, the bot's
 * relay selector falls back to dir-only matching, which routes messages to
 * the wrong session when more than one runs in the same project, and breaks
 * the AUQ topic→session binding entirely.
 *
 * This sweep scans every port file in STATE_DIR; for each one missing
 * sessionId, it looks at `~/.claude/projects/<dir-encoded>/` for a JSONL born
 * after the relay process started and not already claimed by another port
 * file, and writes the discovered sessionId in.
 *
 * Safe to re-run — already-populated entries are skipped, and the inner write
 * goes through `updatePortFile` which merges rather than overwrites.
 */

import { readdir, readFile, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { STATE_DIR } from "../paths";
import { updatePortFile, isProcessAlive, type PortFileData } from "./discovery";
import { info, warn } from "../logger";

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function claudeProjectDir(workingDir: string): string {
  return join(homedir(), ".claude", "projects", workingDir.replace(/\//g, "-"));
}

async function findUnclaimedSessionId(
  projectDir: string,
  startedAtMs: number,
  claimed: Set<string>,
): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return undefined;
  }
  let best: { id: string; mtime: number } | undefined;
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const id = f.slice(0, -6);
    if (!SESSION_ID_RE.test(id)) continue;
    if (claimed.has(id)) continue;
    try {
      const s = await stat(join(projectDir, f));
      // birthtime is unreliable on Linux, so prefer mtime here. The "after
      // startedAt" window has a 60s buffer to allow for clock skew between
      // the relay process and the filesystem; sessions normally write
      // within seconds of start.
      if (s.mtimeMs + 60_000 < startedAtMs) continue;
      if (!best || s.mtimeMs > best.mtime) {
        best = { id, mtime: s.mtimeMs };
      }
    } catch {
      // stat failed — skip
    }
  }
  return best?.id;
}

/**
 * Read port files directly rather than going through scanPortFiles — the
 * latter's stale-cleanup side-effect (unlinking files whose pid isn't a
 * recognised channel-relay process) is undesirable here, and we want backfill
 * to be tolerant of older relay processes whose `ps` command string may have
 * changed.
 */
async function readAllPortFiles(): Promise<PortFileData[]> {
  let entries: string[];
  try {
    entries = await readdir(STATE_DIR);
  } catch {
    return [];
  }
  const out: PortFileData[] = [];
  for (const f of entries) {
    if (!f.startsWith("channel-relay-") || !f.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(STATE_DIR, f), "utf-8");
      const data = JSON.parse(raw) as PortFileData;
      if (data.port && data.pid && data.cwd) out.push(data);
    } catch {
      // Malformed file — skip
    }
  }
  return out;
}

export async function backfillPortFileSessionIds(): Promise<void> {
  let scanned = 0;
  let backfilled = 0;
  try {
    const ports = await readAllPortFiles();
    scanned = ports.length;
    // Collect all sessionIds currently claimed by *other* port files so we
    // don't double-claim a JSONL.
    const claimed = new Set<string>();
    for (const pf of ports) {
      if (pf.sessionId) claimed.add(pf.sessionId);
    }
    for (const pf of ports) {
      if (pf.sessionId) continue;
      if (!isProcessAlive(pf.pid)) continue;
      const startedAtMs = Date.parse(pf.startedAt);
      if (Number.isNaN(startedAtMs)) continue;
      const id = await findUnclaimedSessionId(
        claudeProjectDir(pf.cwd),
        startedAtMs,
        claimed,
      );
      if (!id) continue;
      claimed.add(id);
      // Await the write so the next scan (callers typically do one
      // immediately) sees the merged sessionId on disk.
      await updatePortFile(pf.pid, { sessionId: id });
      backfilled++;
      info(
        `backfill: wrote sessionId=${id} into port file for pid=${pf.pid} cwd=${pf.cwd}`,
      );
    }
  } catch (err) {
    warn(`backfill: port-file sweep failed: ${(err as Error)?.message ?? err}`);
    return;
  }
  if (scanned > 0) {
    info(
      `backfill: scanned ${scanned} port files, backfilled ${backfilled} sessionIds`,
    );
  }
}
