/**
 * /ralph — start, watch, and stop a ralph loop (afk_tasks.sh) from Telegram.
 *
 *   /ralph                                  → status
 *   /ralph <path> [N] [-pr] [-l <label>]    → start (N defaults to 10)
 *   /ralph stop                             → tree-kill + finalize
 *   /ralph verbose on|off                   → toggle transcript streaming
 *
 * One loop at a time. The loop runs in a visible desktop terminal; distilled
 * beats land in a dedicated forum topic that bypasses the topic-store
 * (invariant 1). See docs/ralph-loops.md.
 */

import { homedir } from "os";
import { basename, join, resolve } from "path";
import { fileURLToPath } from "url";
import { access } from "fs/promises";
import type { Context } from "grammy";
import {
  ALLOWED_USERS,
  RALPH_SCRIPT,
  RALPH_PROMPT,
  isDesktopClaudeSpawnSupported,
} from "../../config";
import { STATE_DIR } from "../../paths";
import {
  getWorkingDir,
  getRalphVerboseDefault,
  getDefaultRalphLabel,
} from "../../settings";
import { isAuthorized } from "../../security";
import { escapeHtml } from "../../formatting";
import { getMessageBus } from "../../messaging";
import { suppressDirNotifications } from "../../sessions";
import { info, warn } from "../../logger";
import {
  getActiveLoop,
  getActiveLoopSync,
  addLoop,
  updateLoop,
} from "../../ralph/store";
import {
  startRalphMonitor,
  stopRalphLoop,
  setRalphVerbose,
  killRalphTree,
} from "../../ralph/monitor";
import {
  busReply,
  bashSingleQuotedPath,
  getTopicManager,
  tryRealpathSync,
} from "./helpers";
import { openMacOSTerminalWithCommand } from "./terminal-launchers";

const USAGE = [
  "<b>Usage:</b>",
  "<code>/ralph &lt;path&gt; [N] [-pr] [-l &lt;label&gt;]</code> — start (N default 10)",
  "<code>/ralph</code> — status",
  "<code>/ralph stop</code> — stop the running loop",
  "<code>/ralph verbose on|off</code> — stream the full transcript",
  "",
  "<i>-l scopes to a GitHub label (default from /settings); -l - forces all issues.</i>",
].join("\n");

// Path to the vendored runner, resolved relative to this source file:
// commands → handlers → src → repo root. fileURLToPath, not .pathname —
// the latter keeps percent-encoding, breaking installs under paths with
// spaces or non-ASCII characters.
const RUNNER_PATH = fileURLToPath(
  new URL("../../../scripts/ralph-runner.sh", import.meta.url),
);

export async function handleRalph(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  const raw = ctx.message?.text ?? "";
  const args = raw.replace(/^\/ralph(@\S+)?\s*/, "").trim();

  if (!args) {
    await status(ctx);
    return;
  }
  const [verb, ...rest] = args.split(/\s+/);
  if (verb === "stop") {
    await stopCmd(ctx);
    return;
  }
  if (verb === "verbose") {
    await verboseCmd(ctx, rest[0]);
    return;
  }
  await startCmd(ctx, args);
}

async function status(ctx: Context): Promise<void> {
  const loop = await getActiveLoop();
  if (!loop) {
    await busReply(ctx, `No loop running.\n\n${USAGE}`, "html");
    return;
  }
  const iter = loop.lastIteration
    ? `${loop.lastIteration.n}/${loop.lastIteration.total}`
    : `–/${loop.iterations}`;
  const uptime = fmtUptime(Date.now() - Date.parse(loop.startedAt));
  await busReply(
    ctx,
    [
      "🔁 <b>Ralph loop running</b>",
      `repo: <code>${escapeHtml(loop.repoPath)}</code>`,
      `iter: <b>${iter}</b> · mode: ${loop.prMode ? "PR" : "direct"}`,
      `verbose: ${loop.verbose ? "on" : "off"} · uptime: ${uptime}`,
    ].join("\n"),
    "html",
  );
}

async function stopCmd(ctx: Context): Promise<void> {
  const stopped = await stopRalphLoop(ctx.api);
  await busReply(ctx, stopped ? "🛑 Stopping loop…" : "❌ No loop running.");
}

async function verboseCmd(ctx: Context, mode?: string): Promise<void> {
  if (mode !== "on" && mode !== "off") {
    await busReply(ctx, "Usage: <code>/ralph verbose on|off</code>", "html");
    return;
  }
  const ok = await setRalphVerbose(ctx.api, mode === "on");
  await busReply(
    ctx,
    ok
      ? `✅ verbose ${mode}`
      : "❌ No loop running — start one with <code>/ralph &lt;path&gt;</code>",
    "html",
  );
}

export interface StartArgs {
  path: string;
  iterations: number;
  prMode: boolean;
  label?: string;
}

/** Parse `<path> [N] [-pr] [-l <label>]` (order-independent flags). */
export function parseStartArgs(args: string): StartArgs | { error: string } {
  const tokens = args.split(/\s+/).filter(Boolean);
  let path: string | undefined;
  let iterations: number | undefined;
  let prMode = false;
  let label: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "-pr" || t === "--pr") {
      prMode = true;
    } else if (t === "-l" || t === "--label") {
      label = tokens[++i];
      if (!label) return { error: "missing label after -l" };
    } else if (/^\d+$/.test(t)) {
      iterations = parseInt(t, 10);
    } else if (path === undefined) {
      path = t;
    } else {
      return { error: `unexpected argument: ${t}` };
    }
  }

  if (!path) return { error: "need a repo path" };
  if (iterations === 0) return { error: "iterations must be ≥ 1" };
  return { path, iterations: iterations ?? 10, prMode, label };
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the effective issue label for a loop:
 *   undefined (no -l)  → the configured default (empty ⇒ no label)
 *   "-"   (-l -)       → force no label, overriding the default
 *   other (-l foo)     → that label
 * Returns undefined when no label should be passed to the script.
 */
export function resolveRalphLabel(
  passed: string | undefined,
  configuredDefault: string,
): string | undefined {
  if (passed === undefined) return configuredDefault.trim() || undefined;
  if (passed === "-") return undefined;
  return passed;
}

async function startCmd(ctx: Context, args: string): Promise<void> {
  if (!isDesktopClaudeSpawnSupported()) {
    await busReply(
      ctx,
      "❌ <b>macOS required</b> — ralph loops run in a desktop terminal on the bot host.",
      "html",
    );
    return;
  }

  const existing = await getActiveLoop();
  if (existing) {
    await busReply(
      ctx,
      `❌ loop already running on <code>${escapeHtml(
        existing.repoPath,
      )}</code> — <code>/ralph stop</code> first`,
      "html",
    );
    return;
  }

  const parsed = parseStartArgs(args);
  if ("error" in parsed) {
    await busReply(ctx, `❌ ${parsed.error}\n\n${USAGE}`, "html");
    return;
  }
  const label = resolveRalphLabel(parsed.label, getDefaultRalphLabel());

  // Resolve relative paths against the configured working dir (~/Dev), matching
  // /new — a bare `foo` means <workingDir>/foo, not cwd/foo. expandHome first so
  // `~`-paths and absolutes stay absolute (resolve() leaves absolutes intact).
  const repo = tryRealpathSync(
    resolve(getWorkingDir(), expandHome(parsed.path)),
  );
  // dir exists?
  try {
    await access(repo);
  } catch {
    await busReply(
      ctx,
      `❌ path not found: <code>${escapeHtml(repo)}</code>`,
      "html",
    );
    return;
  }
  // git repo?
  const git = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--git-dir"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (git.exitCode !== 0) {
    await busReply(
      ctx,
      `❌ not a git repo: <code>${escapeHtml(repo)}</code>`,
      "html",
    );
    return;
  }
  // runner present + executable?
  try {
    await access(RUNNER_PATH);
  } catch {
    await busReply(
      ctx,
      `❌ ralph runner missing at <code>${escapeHtml(RUNNER_PATH)}</code>`,
      "html",
    );
    return;
  }

  const id = `${Date.now().toString(36)}${Math.floor(
    Math.random() * 1296,
  ).toString(36)}`;
  const runDir = join(STATE_DIR, "ralph", id);

  const added = await addLoop({
    id,
    repoPath: repo,
    iterations: parsed.iterations,
    prMode: parsed.prMode,
    label,
    pid: undefined,
    topicId: undefined,
    chatId: undefined,
    runDir,
    tailOffset: 0,
    verbose: getRalphVerboseDefault(),
    startedAt: new Date().toISOString(),
  });
  if (!added.ok) {
    await busReply(ctx, `❌ ${added.error}`, "html");
    return;
  }
  const loop = added.loop;

  // Create a raw forum topic — NOT via TopicManager, so reconcile() never
  // deletes it (invariant 1). Fall back to the invoking chat if it fails.
  const topicChatId = getTopicManager()?.getChatId() ?? ctx.chat?.id;
  if (topicChatId !== undefined) {
    try {
      const t = await ctx.api.createForumTopic(
        topicChatId,
        `🔁 ralph ${basename(repo)}`,
      );
      loop.chatId = topicChatId;
      loop.topicId = t.message_thread_id;
    } catch (err) {
      warn(`ralph: createForumTopic failed, using invoking chat: ${err}`);
      loop.chatId = ctx.chat?.id;
      loop.topicId = undefined;
    }
  } else {
    loop.chatId = ctx.chat?.id;
  }
  await updateLoop(loop.id, { chatId: loop.chatId, topicId: loop.topicId });

  // Mute online/offline broadcasts + auto-topic for the ephemeral claudes.
  suppressDirNotifications(repo, 600_000);

  // Build the shell command the terminal runs. The runner cd's into the repo
  // itself; env prefixes only for overrides actually configured.
  const afkArgs: string[] = [];
  if (loop.prMode) afkArgs.push("-pr");
  if (loop.label) afkArgs.push("-l", loop.label);
  afkArgs.push(String(loop.iterations));

  const envPrefix =
    (RALPH_SCRIPT
      ? `RALPH_SCRIPT=${bashSingleQuotedPath(RALPH_SCRIPT)} `
      : "") +
    (RALPH_PROMPT ? `RALPH_PROMPT=${bashSingleQuotedPath(RALPH_PROMPT)} ` : "");
  const cmdParts = [
    bashSingleQuotedPath(RUNNER_PATH),
    bashSingleQuotedPath(runDir),
    bashSingleQuotedPath(repo),
    ...afkArgs.map(bashSingleQuotedPath),
  ];
  const shellCmd = `${envPrefix}exec ${cmdParts.join(" ")}`;

  const term = openMacOSTerminalWithCommand(shellCmd, repo);
  if (!term.ok) {
    await updateLoop(loop.id, {
      state: "ended",
      endedAt: new Date().toISOString(),
      endReason: "spawn-failed",
    });
    await busReply(
      ctx,
      `❌ Could not open terminal.\n<code>${escapeHtml(
        term.stderr || "launcher failed",
      )}</code>`,
      "html",
    );
    return;
  }

  const scope = loop.label
    ? `label <code>${escapeHtml(loop.label)}</code>`
    : "all open issues";
  await busReply(
    ctx,
    `🔁 Launching ralph on <code>${escapeHtml(basename(repo))}</code> — ${
      loop.iterations
    } iterations, ${loop.prMode ? "PR" : "direct"} mode, ${scope}. Watching for beats…`,
    "html",
  );

  // Poll for meta.json (pid) — the runner writes it on start.
  const pid = await pollForPid(runDir);

  // /ralph stop may have finalized the record while we polled (it can't kill
  // what it doesn't know the pid of). Don't resurrect a stopped loop — reap
  // the terminal process now that we finally know its pid.
  if (getActiveLoopSync()?.id !== loop.id) {
    if (pid !== null) {
      await killRalphTree(pid).catch(() => {});
      info(`ralph: loop ${loop.id} stopped during spawn — killed pid ${pid}`);
    }
    return;
  }

  if (pid === null) {
    await updateLoop(loop.id, {
      state: "ended",
      endedAt: new Date().toISOString(),
      endReason: "spawn-failed",
    });
    await busReply(
      ctx,
      "❌ Loop did not start (no meta.json after 30s). Check the terminal window.",
    );
    return;
  }

  loop.pid = pid;
  loop.state = "running";
  await updateLoop(loop.id, { pid, state: "running" });
  startRalphMonitor(ctx.api, loop);

  const started = `▶️ loop started — <code>${escapeHtml(basename(repo))}</code> · ${
    loop.iterations
  } iterations · ${loop.prMode ? "PR" : "direct"} mode`;
  if (loop.chatId !== undefined) {
    const res = await getMessageBus().send({
      chatId: loop.chatId,
      threadId: loop.topicId,
      content: started,
      format: "html",
    });
    // Pin the started message as the initial progress marker; each iteration
    // beat repins over it (monitor.pinLatest), so the pinned message always
    // shows where the loop is at.
    if (res && "messageId" in res) {
      loop.pinnedMessageId = res.messageId;
      await updateLoop(loop.id, { pinnedMessageId: res.messageId });
      await ctx.api
        .pinChatMessage(loop.chatId, res.messageId, {
          disable_notification: true,
        })
        .catch((err) => warn(`ralph: pin started failed: ${err}`));
    }
  }
  info(`ralph: started loop ${loop.id} pid=${pid} repo=${repo}`);
}

async function pollForPid(runDir: string): Promise<number | null> {
  const metaPath = join(runDir, "meta.json");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const raw = await Bun.file(metaPath).text();
      const meta = JSON.parse(raw) as { pid?: number };
      if (typeof meta.pid === "number") return meta.pid;
    } catch {
      // not written yet
    }
    await Bun.sleep(1_000);
  }
  return null;
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
