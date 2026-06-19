/**
 * /cleanzombie — delete forum topics that the bot created but no longer tracks.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { LOG_DIR } from "../../paths";
import type { Context } from "grammy";
import { GrammyError } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import { getTopicStore, getTopicBySession } from "../../topics";
import type { LedgerEntry } from "../../topics";
import { getSessions } from "../../sessions";
import { scanPortFiles } from "../../relay";
import { info, warn } from "../../logger";
import { busReply, getTopicManager } from "./helpers";

/**
 * /cleanzombie — delete forum topics that the bot created but no longer tracks.
 *
 * Telegram's Bot API has no list-topics method, so:
 *   /cleanzombie           — log-scan (only finds zombies whose creation line
 *                            is still in the log file at $CLEANZOMBIE_LOG_PATH).
 *   /cleanzombie sweep [N] — probes every thread id up to N (default: highest
 *                            id seen in the log + 20), skipping live ones.
 *                            Errors from "not found" are ignored; any topic
 *                            the bot has permission to delete gets deleted.
 */
export async function handleCleanZombie(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  const store = getTopicStore();
  if (!store.chatId) {
    await busReply(ctx, "ℹ️ No forum group registered — nothing to clean.");
    return;
  }

  const args = (ctx.message?.text || "").split(/\s+/).slice(1);
  const mode = args[0]?.toLowerCase();
  const sweepLimitArg = args[1] ? parseInt(args[1], 10) : NaN;

  // Log-scan only catches topics unknown to the store, so reconcile first
  // to prune mappings whose session died mid-run.
  let reconciled = 0;
  const tm = getTopicManager();
  if (tm && mode !== "sweep") {
    const before = store.topics.length;
    try {
      const liveSessions = getSessions();
      await tm.reconcile(
        liveSessions.map((s) => ({ name: s.name, dir: s.dir, id: s.id })),
      );
      reconciled = Math.max(0, before - store.topics.length);
    } catch (err) {
      warn(`cleanzombie: reconcile failed: ${err}`);
    }
  }
  const pruneNote =
    reconciled > 0 ? `Pruned ${reconciled} orphan mapping(s).` : "";

  const logPath = process.env.CLEANZOMBIE_LOG_PATH || join(LOG_DIR, "bot.log");
  let logContent = "";
  try {
    logContent = await readFile(logPath, "utf-8");
  } catch {
    logContent = "";
  }

  const created = new Set<number>();
  const deleted = new Set<number>();
  for (const line of logContent.split("\n")) {
    const c = line.match(/topic-manager: created topic (\d+)/);
    if (c) created.add(parseInt(c[1]!, 10));
    const d = line.match(/topic-manager: deleted topic (\d+)/);
    if (d) deleted.add(parseInt(d[1]!, 10));
  }

  const live = new Set(store.topics.map((t) => t.topicId));

  // Ledger pass — the durable record of every topic the bot created. For the
  // default `/cleanzombie` mode, an entry is a zombie when its session is no
  // longer live (judged by relay port files / connected Cursor bridges — the
  // only signals that actually track a process). For `sweep` mode, EVERY
  // active ledger entry not in the live snapshot is a zombie candidate (this
  // catches duplicate topics for still-live sessions — same sessionName, old
  // orphaned topicId).
  const ledgerSessionByTopic = new Map<number, string>();
  const linearMode = mode === "sweep" && args[1]?.toLowerCase() === "linear";
  if (mode !== "sweep" || !linearMode) {
    try {
      // Dynamic imports: keep the static module graph of commands.ts free of
      // the cursor bridge and ledger modules, which test harnesses mock.
      const { getActiveCursorSessionNames } = await import("../../cursor");
      const { readActiveLedger } = await import("../../topics");
      const [ledgerEntries, portFiles] = await Promise.all([
        readActiveLedger(),
        scanPortFiles(true),
      ]);
      const cursorLive = getActiveCursorSessionNames();
      const isLedgerSessionLive = (e: LedgerEntry): boolean => {
        if (cursorLive.has(e.sessionName)) return true;
        if (e.sessionId && portFiles.some((p) => p.sessionId === e.sessionId))
          return true;
        if (portFiles.some((p) => p.sessionName === e.sessionName)) return true;
        if (e.sessionDir && portFiles.some((p) => p.cwd === e.sessionDir))
          return true;
        return false;
      };
      for (const e of ledgerEntries) {
        if (mode === "sweep") {
          // sweep: any ledger entry whose topicId isn't the currently-tracked
          // one is an orphan, even if the session is still live elsewhere.
          if (!live.has(e.topicId))
            ledgerSessionByTopic.set(e.topicId, e.sessionName);
        } else if (!isLedgerSessionLive(e)) {
          ledgerSessionByTopic.set(e.topicId, e.sessionName);
        }
      }
    } catch (err) {
      warn(`cleanzombie: ledger pass failed: ${err}`);
    }
  }

  let candidates: number[];
  if (mode === "sweep" && linearMode) {
    // Linear scan — fallback for ledger-loss recovery. Probes 2..upper.
    const upperArg = args[2] ? parseInt(args[2], 10) : NaN;
    const maxKnown = Math.max(0, ...created, ...live);
    const upper =
      Number.isFinite(upperArg) && upperArg > 0 ? upperArg : maxKnown + 20;
    candidates = [];
    // Skip id=1 (General topic — cannot be deleted).
    for (let id = 2; id <= upper; id++) {
      if (!live.has(id)) candidates.push(id);
    }
    await busReply(
      ctx,
      `🧹 Linear sweep ids 2..${upper} (${candidates.length} to probe). ` +
        `Slow — most ids are not topics.`,
    );
  } else if (mode === "sweep") {
    // Ledger-driven sweep — probe only known topic ids not in the live snapshot.
    candidates = [...ledgerSessionByTopic.keys()].sort((a, b) => a - b);
    if (candidates.length === 0) {
      const prefix = pruneNote ? `🧹 ${pruneNote}\n` : "";
      await busReply(
        ctx,
        `${prefix}✅ No ledger zombies. ${store.topics.length} live topic(s).\n` +
          `Try <code>/cleanzombie sweep linear</code> to probe ids blindly.`,
        "html",
      );
      return;
    }
    await busReply(
      ctx,
      `🧹 Sweeping ${candidates.length} ledger orphan(s) (topics not in live snapshot)…`,
    );
  } else {
    // Union of log-scan zombies (orphans unknown to the store) and ledger
    // zombies (topics whose session is dead, even if still in the store).
    const logZombies = [...created].filter(
      (id) => !deleted.has(id) && !live.has(id),
    );
    candidates = [
      ...new Set([...logZombies, ...ledgerSessionByTopic.keys()]),
    ].sort((a, b) => a - b);
    if (candidates.length === 0) {
      const prefix = pruneNote ? `🧹 ${pruneNote}\n` : "";
      await busReply(
        ctx,
        `${prefix}✅ No zombies found. ${store.topics.length} live topic(s).\n` +
          `Try <code>/cleanzombie sweep</code> to probe by id range.`,
        "html",
      );
      return;
    }
    const prefix = pruneNote ? `${pruneNote} ` : "";
    await busReply(
      ctx,
      `🧹 ${prefix}Cleaning ${candidates.length} zombie topic(s)…`,
    );
  }

  // Dynamic import — see the ledger-pass note above; keeps the topics module
  // (mocked by some test harnesses) out of this file's static graph.
  const { recordTopicDeleted, removeTopicMapping } =
    await import("../../topics");

  let removed = 0;
  const failures: number[] = [];
  const skipReasons = new Map<string, number>();
  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i]!;
    try {
      await ctx.api.deleteForumTopic(store.chatId, id);
      info(`cleanzombie: deleted topic ${id}`);
      removed++;
      // Tombstone in the ledger so a future run never re-probes this id, and
      // drop any lingering store mapping for a ledger-sourced zombie.
      await recordTopicDeleted(id);
      const sessionName = ledgerSessionByTopic.get(id);
      if (sessionName) removeTopicMapping(sessionName);
    } catch (err) {
      if (err instanceof GrammyError) {
        if (err.error_code === 429) {
          // Telegram flood wait — honor retry_after and retry this id.
          const retryAfter = (err.parameters as { retry_after?: number })
            ?.retry_after;
          const waitMs = Math.max(1000, (retryAfter ?? 1) * 1000);
          warn(`cleanzombie: 429, waiting ${waitMs}ms before retry`);
          await Bun.sleep(waitMs);
          i--;
          continue;
        }
        if (err.error_code === 400) {
          const reason = err.description || "unknown";
          skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
          info(`cleanzombie: skip topic ${id}: ${reason}`);
          // Self-heal: TG says this topic id doesn't exist → tombstone the
          // ledger so future runs skip it. Same treatment for "not found"
          // variants. Drop the snapshot mapping ONLY if the session's current
          // topic id matches `id` — otherwise we'd wipe a still-live mapping
          // when probing a stale ledger entry whose session has since been
          // re-topiced.
          if (
            reason.includes("TOPIC_ID_INVALID") ||
            reason.includes("message thread not found")
          ) {
            await recordTopicDeleted(id);
            const sessionName = ledgerSessionByTopic.get(id);
            if (sessionName) {
              const current = getTopicBySession(sessionName);
              if (current?.topicId === id) removeTopicMapping(sessionName);
            }
          }
        } else {
          failures.push(id);
          warn(`cleanzombie: delete failed for ${id}: ${err}`);
        }
      } else {
        failures.push(id);
        warn(`cleanzombie: delete failed for ${id}: ${err}`);
      }
    }
    // Pace deletes under Telegram's ~30 req/s global limit.
    if (mode === "sweep" && i + 1 < candidates.length) await Bun.sleep(50);
  }

  let reply = `🧹 Deleted ${removed} topic(s).`;
  if (pruneNote) reply += ` ${pruneNote}`;
  if (skipReasons.size > 0) {
    const breakdown = [...skipReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([r, n]) => `${n}× ${r}`)
      .join("\n  ");
    reply += `\nSkipped 400s:\n  ${breakdown}`;
  }
  if (failures.length) {
    reply += `\n⚠️ ${failures.length} error(s), first few: ${failures
      .slice(0, 5)
      .join(", ")}`;
  }
  await busReply(ctx, reply);
}
