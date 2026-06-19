/**
 * Append-only ledger of every Telegram forum topic the bot has created.
 *
 * Telegram has no list-topics API, and bot.log rotates — so without a durable
 * record, topics created in past runs become unreachable orphans. This ledger
 * is the permanent source of truth for "which topic ids exist": createTopic()
 * appends a `created` event, deleteTopic() appends a `deleted` event, and
 * entries are never dropped. `/cleanzombie` walks it to find topics whose
 * session is no longer live.
 *
 * Stored as JSONL — one event per line — so appends need no read-modify-write
 * and no lock. Bun/Node's `appendFile` isn't guaranteed to be a single
 * `write(2)` syscall (it's promise-backed and may split), but `readLedger`
 * tolerates torn lines via the JSON.parse catch, so a partial append worst-
 * case loses one event rather than corrupting the file.
 *
 * `readLedger` re-reads the whole file on every call. Fine while the ledger
 * is small (one entry per topic ever created); if it grows large enough to
 * matter, fold to a snapshot or periodically compact deleted entries.
 */

import { appendFile, readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { warn } from "../logger";

interface CreatedEvent {
  type: "created";
  topicId: number;
  sessionName: string;
  sessionDir: string;
  sessionId?: string;
  at: string;
}
interface DeletedEvent {
  type: "deleted";
  topicId: number;
  at: string;
}
type LedgerEvent = CreatedEvent | DeletedEvent;

export interface LedgerEntry {
  topicId: number;
  sessionName: string;
  sessionDir: string;
  sessionId?: string;
  createdAt: string;
  deletedAt?: string;
}

function ledgerPath(): string {
  return (
    process.env.CLAUDE_TELEGRAM_LEDGER_FILE ??
    join(homedir(), ".claude-mobile-bridge", "topic-ledger.jsonl")
  );
}

async function append(event: LedgerEvent): Promise<void> {
  try {
    await appendFile(ledgerPath(), JSON.stringify(event) + "\n");
  } catch (err) {
    warn(`topic-ledger: append failed: ${err}`);
  }
}

export function recordTopicCreated(entry: {
  topicId: number;
  sessionName: string;
  sessionDir: string;
  sessionId?: string;
}): Promise<void> {
  return append({ type: "created", ...entry, at: new Date().toISOString() });
}

export function recordTopicDeleted(topicId: number): Promise<void> {
  return append({ type: "deleted", topicId, at: new Date().toISOString() });
}

/**
 * Record a topic the bot didn't know about — observed via inbound message
 * thread_id. Uses a placeholder sessionName so `/cleanzombie` treats it as an
 * orphan with no live session, and uses its topicId in candidate sets.
 * Idempotent at the per-process level via `discovered` (in-memory cache).
 */
const discovered = new Set<number>();
export async function recordTopicDiscovered(topicId: number): Promise<boolean> {
  if (discovered.has(topicId)) return false;
  discovered.add(topicId);
  // Avoid recording if the ledger already has any entry for this id — readLedger
  // is cheap (one file read) and this only fires the first time we see an id
  // this process. Future calls hit the in-memory set.
  const seen = new Set((await readLedger()).map((e) => e.topicId));
  if (seen.has(topicId)) return false;
  await append({
    type: "created",
    topicId,
    sessionName: `discovered-${topicId}`,
    sessionDir: "",
    at: new Date().toISOString(),
  });
  return true;
}

/**
 * Fold the event log into one entry per topic id. The newest event for an id
 * wins, so a `deleted` after a `created` marks the entry deleted.
 */
export async function readLedger(): Promise<LedgerEntry[]> {
  let content = "";
  try {
    content = await readFile(ledgerPath(), "utf-8");
  } catch {
    return []; // no ledger yet
  }

  const byId = new Map<number, LedgerEntry>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: LedgerEvent;
    try {
      ev = JSON.parse(trimmed) as LedgerEvent;
    } catch {
      continue; // skip a torn/partial line
    }
    if (ev.type === "created") {
      byId.set(ev.topicId, {
        topicId: ev.topicId,
        sessionName: ev.sessionName,
        sessionDir: ev.sessionDir,
        sessionId: ev.sessionId,
        createdAt: ev.at,
      });
    } else if (ev.type === "deleted") {
      const existing = byId.get(ev.topicId);
      if (existing) {
        existing.deletedAt = ev.at;
      } else {
        // `deleted` with no preceding `created` (ledger started mid-life) —
        // keep a tombstone so the id is never treated as active.
        byId.set(ev.topicId, {
          topicId: ev.topicId,
          sessionName: "",
          sessionDir: "",
          createdAt: "",
          deletedAt: ev.at,
        });
      }
    }
  }
  return [...byId.values()];
}

/** Ledger entries for topics created and not yet recorded as deleted. */
export async function readActiveLedger(): Promise<LedgerEntry[]> {
  return (await readLedger()).filter(
    (e) => !e.deletedAt && Boolean(e.createdAt),
  );
}

/**
 * Append a `created` event for every topic mapping whose topic id is missing
 * from the ledger. Idempotent — re-runs do nothing once a mapping is recorded.
 * Returns the number of entries backfilled.
 *
 * Use case: topics that existed before the ledger module shipped have no
 * ledger entry, so /cleanzombie's liveness pass never sees them. Running this
 * on bot startup (after loadTopicStore) brings the ledger in sync with the
 * store, so going forward every tracked topic is visible to cleanzombie.
 */
export async function backfillLedgerFromStore(
  mappings: ReadonlyArray<{
    topicId: number;
    sessionName: string;
    sessionDir: string;
    sessionId?: string;
  }>,
): Promise<number> {
  const seen = new Set((await readLedger()).map((e) => e.topicId));
  let added = 0;
  for (const m of mappings) {
    if (seen.has(m.topicId)) continue;
    await recordTopicCreated({
      topicId: m.topicId,
      sessionName: m.sessionName,
      sessionDir: m.sessionDir,
      sessionId: m.sessionId,
    });
    added++;
  }
  return added;
}
