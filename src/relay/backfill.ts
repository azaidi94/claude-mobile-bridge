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
import { join } from "path";
import { STATE_DIR, claudeProjectDir } from "../paths";
import {
  updatePortFile,
  isProcessAlive,
  isOrphanedRelay,
  type PortFileData,
} from "./discovery";
import { info, warn, debug } from "../logger";

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    // Count live relays per cwd. Never guess an id for a relay that shares its
    // cwd with another live relay (siblings): a mtime-guessed JSONL routinely
    // grabs the sibling's transcript, and writing it into the port file
    // persists the misroute. Only lone relays are safe to back-fill; siblings
    // get their real id from the SessionStart hook / relay self-discovery, and
    // exact pid routing handles them meanwhile. (Mirrors resolveIdentities'
    // `ambiguous` rule — the single never-guess-across-siblings principle.)
    // An orphan (relay alive, its claude dead) is not a sibling — counting one
    // would suppress backfill for the legitimate relay that replaced it, which
    // is exactly the shape a restarted session leaves behind.
    const liveRelaysPerCwd = new Map<string, number>();
    for (const pf of ports) {
      if (isProcessAlive(pf.pid) && !isOrphanedRelay(pf)) {
        liveRelaysPerCwd.set(pf.cwd, (liveRelaysPerCwd.get(pf.cwd) ?? 0) + 1);
      }
    }
    for (const pf of ports) {
      if (pf.sessionId) continue;
      if (!isProcessAlive(pf.pid)) continue;
      if (isOrphanedRelay(pf)) continue;
      if ((liveRelaysPerCwd.get(pf.cwd) ?? 0) > 1) continue; // ambiguous sibling
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
      // immediately) sees the merged sessionId on disk. preserveExisting guards
      // the backfill-vs-hook race: if the SessionStart hook wrote the real id
      // while our async mtime lookup was in flight, we must not clobber it with
      // this guess — the guarded merge drops sessionId when one is already set.
      await updatePortFile(
        pf.pid,
        { sessionId: id },
        { preserveExisting: ["sessionId"] },
      );
      backfilled++;
      info("backfill: wrote sessionId into port file", {
        sessionId: id,
        pid: pf.pid,
        cwd: pf.cwd,
      });
    }
  } catch (err) {
    warn("backfill: port-file sweep failed", err);
    return;
  }
  // The sweep runs on every watcher refresh; when it changes nothing (the
  // steady state) it is pure noise, so keep the no-op summary at debug and
  // only surface an info line on the ticks that actually backfilled something.
  if (backfilled > 0) {
    info("backfill: swept port files", { scanned, backfilled });
  } else if (scanned > 0) {
    debug("backfill: swept port files (no change)", { scanned });
  }
}
