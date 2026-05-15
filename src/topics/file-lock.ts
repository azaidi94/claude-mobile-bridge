/**
 * Cross-process advisory file lock.
 *
 * Bun/Node have no portable `flock`, so this uses the standard atomic-create
 * pattern: `open(lockPath, "wx")` succeeds for exactly one process; everyone
 * else spins until the holder releases (unlinks) it. A stale lock — holder
 * crashed without releasing — is stolen once it ages past `LOCK_STALE_MS`.
 *
 * Used to serialise read-modify-write on shared JSON state (topics.json) when
 * more than one bot process runs against the same filesystem.
 */

import { open, unlink, stat } from "fs/promises";

const LOCK_STALE_MS = 10_000;
const RETRY_MS = 25;
const MAX_WAIT_MS = 5_000;

export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + MAX_WAIT_MS;

  for (;;) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      // Lock is held. Steal it if the holder appears to have crashed.
      // Note: two concurrent stealers can both unlink and both retry "wx" —
      // exactly one will win EEXIST, the loser falls back into the spin loop.
      // The double-unlink is harmless (the second hits ENOENT, swallowed).
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        // Lock vanished between open() and stat() — retry the acquire.
      }
      if (Date.now() > deadline) {
        throw new Error(`withFileLock: timed out waiting for ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}
