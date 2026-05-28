/**
 * Shared spawn-Claude-in-terminal flow used by /new and /sessions resume.
 *
 * Opens a macOS Terminal (or iTerm) in `explicitPath` running Claude with
 * relay flags, then waits for the channel relay to surface, activates the
 * resulting session, creates a topic, and starts watching.
 */

import { access } from "fs/promises";
import type { Context } from "grammy";
import { escapeHtml } from "../../formatting";
import { getAutoWatchOnSpawn } from "../../settings";
import {
  getSessions,
  setActiveSession,
  forceRefresh,
  suppressDirNotifications,
} from "../../sessions";
import { scanPortFiles } from "../../relay";
import { startWatchingSession } from "../watch";
import {
  createOpId,
  elapsedMs,
  error as logError,
  info,
  warn,
} from "../../logger";
import { getMessageBus } from "../../messaging";
import {
  assertDesktopSpawnReady,
  getTopicManager,
  relayIdentity,
  tryRealpathSync,
} from "./helpers";
import {
  buildDesktopShellCommand,
  openMacOSTerminalWithCommand,
} from "./terminal-launchers";

/**
 * Opens a macOS Terminal (or iTerm) in `explicitPath` running Claude with relay
 * flags, then waits for the channel relay and attaches watch — shared by /new and
 * /sessions → Resume.
 */
export async function spawnDesktopClaudeSession(
  api: Context["api"],
  chatId: number,
  explicitPath: string,
  userId: number,
): Promise<void> {
  const bus = getMessageBus();
  const claudePath = await assertDesktopSpawnReady((text) =>
    bus.send({ chatId, content: text, format: "html" }),
  );
  if (!claudePath) return;

  const opId = createOpId("spawn");
  const spawnStartedAt = Date.now();
  info("spawn: started", { opId, chatId, userId, explicitPath });

  try {
    try {
      await access(explicitPath);
    } catch {
      warn("spawn: cwd not found or inaccessible", {
        opId,
        chatId,
        userId,
        explicitPath,
        durationMs: elapsedMs(spawnStartedAt),
      });
      await bus.send({
        chatId,
        content:
          "❌ That project path is missing or not readable on the machine running the bot.\n\n" +
          `<code>${escapeHtml(explicitPath)}</code>\n\n` +
          "Paths must exist on the Mac where the bot runs.",
        format: "html",
      });
      return;
    }

    const spawnCwd = tryRealpathSync(explicitPath);
    info("spawn: canonical cwd", { opId, spawnCwd });

    // Memoize realpath — `spawnCwd` is stable, but every port-file /
    // session `cwd` we compare against would otherwise be re-canonicalized
    // on every 2s poll iteration.
    const realpathCache = new Map<string, string>();
    const canonical = (p: string): string => {
      const hit = realpathCache.get(p);
      if (hit !== undefined) return hit;
      const r = tryRealpathSync(p);
      realpathCache.set(p, r);
      return r;
    };

    const [initialPortFiles, initialSessions] = await Promise.all([
      scanPortFiles(true),
      Promise.resolve(getSessions()),
    ]);
    const beforeRelays = initialPortFiles.filter(
      (pf) => canonical(pf.cwd) === spawnCwd,
    );
    const knownRelayIds = new Set(beforeRelays.map(relayIdentity));
    const beforeSessions = initialSessions.filter(
      (s) => canonical(s.dir) === spawnCwd,
    );
    const knownSessionIds = new Set(
      beforeSessions.map((s) => s.id).filter(Boolean),
    );
    const knownSessionPids = new Set(
      beforeSessions
        .map((s) => s.pid)
        .filter((pid): pid is number => pid !== undefined),
    );

    // Watcher would otherwise broadcast a redundant "🟢 online" for this
    // dir — spawn flow edits its own status bubble once the relay appears.
    // Suppression outlives the 120s poll deadline.
    suppressDirNotifications(spawnCwd, 150_000);

    const shellCmd = buildDesktopShellCommand(explicitPath, claudePath);
    const term = openMacOSTerminalWithCommand(shellCmd, explicitPath);
    if (!term.ok) {
      warn("spawn: osascript failed", {
        opId,
        chatId,
        userId,
        explicitPath,
        stderr: term.stderr.slice(0, 500),
        durationMs: elapsedMs(spawnStartedAt),
      });
      await bus.send({
        chatId,
        content:
          "❌ Could not open Terminal.\n\n" +
          `<code>${escapeHtml(term.stderr || "osascript failed")}</code>`,
        format: "html",
      });
      return;
    }

    // setWorkingDir is deferred to the success branch — osascript can
    // report success even if Terminal silently fails to launch
    // (Accessibility denied, profile issue), so we only commit the dir
    // after a port file confirms a live claude in it.
    const statusSend = await bus.send({
      chatId,
      content:
        "⏳ Terminal opened — starting Claude.\n\n" +
        "<b>At the Mac:</b> if you see the development-channels menu, choose <b>1</b> (local development) and press Enter.\n\n" +
        "<b>Remote only:</b> set <code>DESKTOP_CLAUDE_COMMAND</code> to <code>…/scripts/claude-relay-launch.sh {dir}</code> (see README) so <code>expect</code> can send that for you.\n\n" +
        `Once the relay connects, <code>/pwd</code> and <code>/ls</code> will switch to this folder.\n\nWaiting for relay…`,
      format: "html",
    });
    const statusMessageId =
      "messageId" in statusSend ? statusSend.messageId : null;
    const editStatus = (text: string): Promise<unknown> => {
      if (statusMessageId === null) return Promise.resolve();
      return bus
        .edit(statusMessageId, { chatId, content: text, format: "html" })
        .catch(() => {});
    };

    await Bun.sleep(4000);

    const deadline = Date.now() + 120_000;
    let spawnedRelay: Awaited<ReturnType<typeof scanPortFiles>>[number] | null =
      null;
    while (Date.now() < deadline) {
      await Bun.sleep(2000);
      const portFiles = await scanPortFiles(true);
      const newRelays = portFiles.filter(
        (pf) =>
          canonical(pf.cwd) === spawnCwd &&
          !knownRelayIds.has(relayIdentity(pf)),
      );
      if (newRelays.length > 1) {
        warn("spawn: ambiguous new relays", {
          opId,
          chatId,
          userId,
          explicitPath,
          durationMs: elapsedMs(spawnStartedAt),
          candidateCount: newRelays.length,
        });
        await editStatus(
          "⚠️ Session spawned, but multiple new relays appeared.\n" +
            "Use /list to pick the right session.",
        );
        return;
      }
      if (newRelays.length === 1) {
        spawnedRelay = newRelays[0]!;
        break;
      }
    }

    if (!spawnedRelay) {
      warn("spawn: relay not detected", {
        opId,
        chatId,
        userId,
        explicitPath,
        durationMs: elapsedMs(spawnStartedAt),
      });
      await editStatus(
        "⚠️ Relay not detected in time (~2 min). In Terminal: finish login, approve dev channels, and ensure MCP <code>channel-relay</code> is registered for that shell. Then <code>/list</code> or <code>/watch</code>.",
      );
      return;
    }

    await forceRefresh();
    const sessions = getSessions();
    const dirSessions = sessions.filter((s) => canonical(s.dir) === spawnCwd);
    let spawned =
      (spawnedRelay.sessionId
        ? dirSessions.find((s) => s.id === spawnedRelay?.sessionId)
        : undefined) ||
      (spawnedRelay.ppid !== undefined
        ? dirSessions.find((s) => s.pid === spawnedRelay?.ppid)
        : undefined);

    if (!spawned) {
      const newCandidates = dirSessions.filter(
        (s) =>
          (Boolean(s.id) && !knownSessionIds.has(s.id)) ||
          (s.pid !== undefined && !knownSessionPids.has(s.pid)),
      );
      if (newCandidates.length === 1) {
        spawned = newCandidates[0]!;
      }
    }

    if (!spawned && beforeSessions.length === 0 && dirSessions.length === 1) {
      spawned = dirSessions[0]!;
    }

    if (spawned) {
      // Relay confirmed live — activate the session and start watching.
      // (Working dir lives per-session on its SessionState, populated lazily
      // when the next handler resolves it via getSessionState.)
      setActiveSession(spawned.name);

      // Create topic BEFORE starting the watch so its id is available.
      let topicId: number | undefined;
      const tm = getTopicManager();
      if (tm) {
        topicId = await tm
          .createTopic(spawned.name, spawnCwd, spawned.id)
          .catch((err) => {
            warn(`spawn: topic creation failed: ${err}`);
            return undefined;
          });
      }

      if (getAutoWatchOnSpawn() && topicId !== undefined) {
        startWatchingSession(api, chatId, topicId, spawned.name, "spawn").catch(
          () => {},
        );
      }

      await editStatus(
        `✅ <b>${escapeHtml(spawned.name)}</b> ready — watching for updates.`,
      );

      info("spawn: completed", {
        opId,
        chatId,
        userId,
        explicitPath,
        sessionName: spawned.name,
        sessionId: spawned.id,
        durationMs: elapsedMs(spawnStartedAt),
      });
    } else {
      warn("spawn: session unresolved after relay detection", {
        opId,
        chatId,
        userId,
        explicitPath,
        durationMs: elapsedMs(spawnStartedAt),
      });
      await editStatus(
        "⚠️ Session spawned, but could not uniquely identify the new session.\n" +
          "Use /list to find it.",
      );
    }
  } catch (err) {
    logError("spawn: failed", err, {
      opId,
      chatId,
      userId,
      explicitPath,
      durationMs: elapsedMs(spawnStartedAt),
    });
    await bus.send({
      chatId,
      content: `❌ Spawn failed: ${String(err).slice(0, 200)}`,
      format: "plain",
    });
  }
}
