import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "../paths";

export interface RegistryRecord {
  launchUuid: string;
  claudePid: number;
  startTime: string;
  sessionId: string;
  cwd: string;
  source: string;
  updatedAt: string;
}

const REGISTRY_DIR = join(STATE_DIR, "registry");

function defaultReadDir(): RegistryRecord[] {
  try {
    return readdirSync(REGISTRY_DIR)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [
            JSON.parse(
              readFileSync(join(REGISTRY_DIR, f), "utf-8"),
            ) as RegistryRecord,
          ];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function readRegistry(
  readDir: () => RegistryRecord[] = defaultReadDir,
): RegistryRecord[] {
  return readDir();
}

export function launchUuidByClaudePid(
  records: RegistryRecord[],
): Map<number, string> {
  const latest = new Map<number, RegistryRecord>();
  for (const rec of records) {
    const cur = latest.get(rec.claudePid);
    if (!cur || rec.updatedAt > cur.updatedAt) latest.set(rec.claudePid, rec);
  }
  return new Map([...latest].map(([pid, rec]) => [pid, rec.launchUuid]));
}

/**
 * The AUTHORITATIVE `sessionId → launchUuid` map. The SessionStart hook writes
 * each record keyed on the real `(claudePid, startTime)` and re-anchors its
 * `sessionId` on every `/clear`, independent of the relay port files — so this
 * map is NOT corruptible by a sibling stamping its port file with another
 * session's id (the vector that misroutes port-file-keyed lookups). Latest
 * record wins per `sessionId`, mirroring `launchUuidByClaudePid`'s tie-break.
 */
export function launchUuidBySessionId(
  records: RegistryRecord[],
): Map<string, string> {
  const latest = new Map<string, RegistryRecord>();
  for (const rec of records) {
    if (!rec.sessionId) continue;
    const cur = latest.get(rec.sessionId);
    if (!cur || rec.updatedAt > cur.updatedAt) latest.set(rec.sessionId, rec);
  }
  return new Map([...latest].map(([sid, rec]) => [sid, rec.launchUuid]));
}
