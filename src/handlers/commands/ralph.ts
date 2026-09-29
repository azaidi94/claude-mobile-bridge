/**
 * /ralph — start, watch, and stop a ralph loop (afk_tasks.sh) from Telegram.
 *
 *   /ralph                                  → status
 *   /ralph <path> [N] [-pr] [-l <label>]    → start (N defaults to 10)
 *   /ralph stop                             → tree-kill + finalize
 *   /ralph verbose on|off                   → toggle transcript streaming
 *   /ralph at <HH:MM> <start args>          → one-shot at next local HH:MM
 *   /ralph every <cron spec> <start args>   → recurring (5 fields, local time)
 *   /ralph jobs                             → list scheduled runs
 *   /ralph unsched <id>                     → remove a scheduled run
 *
 * Schedules live in the cron store (kind=ralph) and fire from the cron
 * scheduler; a fire while a loop is running is skipped, not queued.
 *
 * One loop at a time. The loop runs in a visible desktop terminal; distilled
 * beats land in a dedicated forum topic that bypasses the topic-store
 * (invariant 1). See docs/ralph-loops.md.
 */

import { homedir } from "os";
import { basename, join, resolve } from "path";
import { fileURLToPath } from "url";
import { access } from "fs/promises";
import type { Api, Context } from "grammy";
import {
  ALLOWED_USERS,
  RALPH_SCRIPT,
  RALPH_PROMPT,
  RALPH_TIMEOUT,
  isDesktopClaudeSpawnSupported,
} from "../../config";
import { STATE_DIR } from "../../paths";
import {
  getWorkingDir,
  getRalphVerboseDefault,
  getDefaultRalphLabel,
} from "../../settings";
import { isAuthorized } from "../../security";
import { escapeHtml, formatLocalDateTime } from "../../formatting";
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
  pinLatest,
} from "../../ralph/monitor";
import {
  busReply,
  bashSingleQuotedPath,
  getTopicManager,
  tryRealpathSync,
} from "./helpers";
import { openMacOSTerminalWithCommand } from "./terminal-launchers";
import { parseCron } from "../../cron/parser";
import {
  addJob,
  getJobs,
  removeJob,
  type RalphJobArgs,
} from "../../cron/store";

const USAGE = [
  "<b>Usage:</b>",
  "<code>/ralph &lt;path&gt; [N] [-pr] [-l &lt;label&gt;]</code> — start (N default 10)",
  "<code>/ralph</code> — status",
  "<code>/ralph stop</code> — stop the running loop",
  "<code>/ralph verbose on|off</code> — stream the full transcript",
  "<code>/ralph at 02:00 &lt;path&gt; …</code> — run once at next 02:00",
  '<code>/ralph every "0 2 * * 1-5" &lt;path&gt; …</code> — recurring',
  "<code>/ralph jobs</code> · <code>/ralph unsched &lt;id&gt;</code>",
  "",
  "<i>Schedules use bot-host local time; a busy loop skips the run.</i>",
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
  if (verb === "at" || verb === "every") {
    await scheduleCmd(ctx, verb, args.slice(verb.length).trim());
    return;
  }
  if (verb === "jobs") {
    await jobsCmd(ctx);
    return;
  }
  if (verb === "unsched") {
    await unschedCmd(ctx, rest[0]);
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

/**
 * Next local occurrence of `HH:MM` strictly after `now` (today if still ahead,
 * else tomorrow). Returns null for malformed times.
 */
export function nextLocalTime(hhmm: string, now: Date): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  if (h > 23 || min > 59) return null;
  // Pick the day first, then set the time once: setHours-then-setDate keeps a
  // DST-shifted wall clock (01:30 on spring-forward day → 02:30 the next day).
  const on = (dayOffset: number) =>
    new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + dayOffset,
      h,
      min,
    );
  const today = on(0);
  return today.getTime() > now.getTime() ? today : on(1);
}

/**
 * Split `every`'s argument into a 5-field cron spec + the remaining start
 * args. The spec may be quoted ("…", '…', or phone-autocorrected “…”) or bare.
 */
export function splitEverySpec(
  rest: string,
): { spec: string; remainder: string } | { error: string } {
  const q = /^(["'“”])(.*?)["'“”](.*)$/s.exec(rest);
  if (q) return { spec: q[2]!.trim(), remainder: q[3]!.trim() };
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 6) return { error: "need 5 cron fields + a repo path" };
  return {
    spec: tokens.slice(0, 5).join(" "),
    remainder: tokens.slice(5).join(" "),
  };
}

/** Label as it'll apply at fire time (unset follows /settings then). */
function describeLabel(label: string | undefined): string {
  if (label === "-") return "all issues";
  if (label !== undefined) return `label <code>${escapeHtml(label)}</code>`;
  return "default label";
}

function describeRalphArgs(a: RalphJobArgs): string {
  return `<code>${escapeHtml(basename(a.path))}</code> · ${a.iterations} iters · ${
    a.prMode ? "PR" : "direct"
  } · ${describeLabel(a.label)}`;
}

async function scheduleCmd(
  ctx: Context,
  verb: "at" | "every",
  rest: string,
): Promise<void> {
  if (!isDesktopClaudeSpawnSupported()) {
    await busReply(
      ctx,
      "❌ <b>macOS required</b> — ralph loops run in a desktop terminal on the bot host.",
      "html",
    );
    return;
  }

  let schedule = "";
  let runAt: string | undefined;
  let startArgs: string;
  let whenText: string;

  if (verb === "at") {
    const [hhmm = "", ...tail] = rest.split(/\s+/);
    const at = nextLocalTime(hhmm, new Date());
    if (!at) {
      await busReply(
        ctx,
        `❌ need a time like <code>02:00</code>\n\n${USAGE}`,
        "html",
      );
      return;
    }
    runAt = at.toISOString();
    startArgs = tail.join(" ");
    whenText = `at ${escapeHtml(formatLocalDateTime(at))} (in ${fmtUptime(
      at.getTime() - Date.now(),
    )})`;
  } else {
    const split = splitEverySpec(rest);
    if ("error" in split) {
      await busReply(ctx, `❌ ${split.error}\n\n${USAGE}`, "html");
      return;
    }
    try {
      parseCron(split.spec);
    } catch (err) {
      await busReply(
        ctx,
        `❌ Invalid spec: <code>${escapeHtml(String(err))}</code>`,
        "html",
      );
      return;
    }
    schedule = split.spec;
    startArgs = split.remainder;
    whenText = `every <code>${escapeHtml(split.spec)}</code> (local)`;
  }

  const parsed = parseStartArgs(startArgs);
  if ("error" in parsed) {
    await busReply(ctx, `❌ ${parsed.error}\n\n${USAGE}`, "html");
    return;
  }
  // Validate + canonicalize now so a typo surfaces at schedule time, not 2am.
  const resolved = await resolveRalphRepo(parsed.path);
  if ("error" in resolved) {
    await busReply(ctx, `❌ ${resolved.error}`, "html");
    return;
  }
  const ralph: RalphJobArgs = { ...parsed, path: resolved.repo };

  const job = await addJob({
    kind: "ralph",
    ralph,
    tz: "local",
    schedule,
    runAt,
    sessionName: "",
    prompt: "",
    enabled: true,
  });
  const { isCronSchedulerRunning } = await import("../../cron/scheduler");
  const warning = isCronSchedulerRunning()
    ? ""
    : "\n⚠️ scheduler not running (no primary chat at boot) — won't fire until the bot restarts with one";
  await busReply(
    ctx,
    `⏰ scheduled <code>${escapeHtml(job.id)}</code> — ${describeRalphArgs(
      ralph,
    )}\n${whenText}${warning}`,
    "html",
  );
}

async function jobsCmd(ctx: Context): Promise<void> {
  const jobs = (await getJobs()).filter((j) => j.kind === "ralph" && j.ralph);
  if (!jobs.length) {
    await busReply(ctx, `No scheduled ralph runs.\n\n${USAGE}`, "html");
    return;
  }
  const lines = jobs.map((j) => {
    const when = j.runAt
      ? `once ${escapeHtml(formatLocalDateTime(new Date(j.runAt)))}`
      : `every <code>${escapeHtml(j.schedule)}</code>`;
    return `<code>${escapeHtml(j.id)}</code> ${when}\n   ${describeRalphArgs(
      j.ralph!,
    )}`;
  });
  await busReply(
    ctx,
    `<b>Scheduled ralph runs</b>\n\n${lines.join("\n\n")}`,
    "html",
  );
}

async function unschedCmd(ctx: Context, id?: string): Promise<void> {
  if (!id) {
    await busReply(ctx, "Need a job id. Use <code>/ralph jobs</code>.", "html");
    return;
  }
  const job = (await getJobs()).find((j) => j.id === id && j.kind === "ralph");
  const ok = job ? await removeJob(id) : false;
  await busReply(
    ctx,
    ok
      ? `🗑 Unscheduled <code>${escapeHtml(id)}</code>`
      : `❌ No scheduled run <code>${escapeHtml(id)}</code>`,
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
  const parsed = parseStartArgs(args);
  if ("error" in parsed) {
    await busReply(ctx, `❌ ${parsed.error}\n\n${USAGE}`, "html");
    return;
  }
  await startRalphLoop(ctx.api, parsed, {
    chatId: ctx.chat?.id,
    reply: (html) => busReply(ctx, html, "html"),
  });
}

/**
 * Resolve a /ralph path to a canonical git repo on the bot host. Relative paths
 * resolve against the configured working dir (~/Dev), matching /new — a bare
 * `foo` means <workingDir>/foo, not cwd/foo. expandHome first so `~`-paths and
 * absolutes stay absolute (resolve() leaves absolutes intact).
 */
export async function resolveRalphRepo(
  path: string,
): Promise<{ repo: string } | { error: string }> {
  const repo = tryRealpathSync(resolve(getWorkingDir(), expandHome(path)));
  try {
    await access(repo);
  } catch {
    return { error: `path not found: <code>${escapeHtml(repo)}</code>` };
  }
  const git = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--git-dir"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (git.exitCode !== 0) {
    return { error: `not a git repo: <code>${escapeHtml(repo)}</code>` };
  }
  return { repo };
}

/** Where startRalphLoop reports progress/errors (HTML). */
export interface RalphStartTarget {
  /** Fallback chat for beats when the forum topic can't be created. */
  chatId?: number;
  reply: (html: string) => Promise<unknown>;
}

/**
 * Validate, spawn, and start monitoring a loop. Shared by `/ralph <path>` and
 * scheduled runs (src/cron/scheduler.ts). Returns true once the loop is running.
 */
export async function startRalphLoop(
  api: Api,
  parsed: StartArgs,
  target: RalphStartTarget,
): Promise<boolean> {
  const { reply } = target;
  if (!isDesktopClaudeSpawnSupported()) {
    await reply(
      "❌ <b>macOS required</b> — ralph loops run in a desktop terminal on the bot host.",
    );
    return false;
  }

  const existing = await getActiveLoop();
  if (existing) {
    await reply(
      `❌ loop already running on <code>${escapeHtml(
        existing.repoPath,
      )}</code> — <code>/ralph stop</code> first`,
    );
    return false;
  }

  const label = resolveRalphLabel(parsed.label, getDefaultRalphLabel());

  const resolved = await resolveRalphRepo(parsed.path);
  if ("error" in resolved) {
    await reply(`❌ ${resolved.error}`);
    return false;
  }
  const repo = resolved.repo;
  // runner present + executable?
  try {
    await access(RUNNER_PATH);
  } catch {
    await reply(
      `❌ ralph runner missing at <code>${escapeHtml(RUNNER_PATH)}</code>`,
    );
    return false;
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
    await reply(`❌ ${added.error}`);
    return false;
  }
  const loop = added.loop;

  // Create a raw forum topic — NOT via TopicManager, so reconcile() never
  // deletes it (invariant 1). Fall back to the invoking chat if it fails.
  const topicChatId = getTopicManager()?.getChatId() ?? target.chatId;
  if (topicChatId !== undefined) {
    try {
      const t = await api.createForumTopic(
        topicChatId,
        `🔁 ralph ${basename(repo)}`,
      );
      loop.chatId = topicChatId;
      loop.topicId = t.message_thread_id;
    } catch (err) {
      // Degraded fallback: the loop posts to the invoking chat instead of its
      // own topic — an operator-visible downgrade, so warn (not debug).
      warn("ralph: createForumTopic failed, using invoking chat", {
        err: String(err),
      });
      loop.chatId = target.chatId;
      loop.topicId = undefined;
    }
  } else {
    loop.chatId = target.chatId;
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
    (RALPH_PROMPT
      ? `RALPH_PROMPT=${bashSingleQuotedPath(RALPH_PROMPT)} `
      : "") +
    // Digits only — anything else is a typo, and passing it through would both
    // inject into the shell line and make the script's `-lt` comparison fail
    // closed (killing every iteration at once). Fall back to the script default.
    (/^\d+$/.test(RALPH_TIMEOUT) ? `RALPH_TIMEOUT=${RALPH_TIMEOUT} ` : "");
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
    await reply(
      `❌ Could not open terminal.\n<code>${escapeHtml(
        term.stderr || "launcher failed",
      )}</code>`,
    );
    return false;
  }

  const scope = loop.label
    ? `label <code>${escapeHtml(loop.label)}</code>`
    : "all open issues";
  await reply(
    `🔁 Launching ralph on <code>${escapeHtml(basename(repo))}</code> — ${
      loop.iterations
    } iterations, ${loop.prMode ? "PR" : "direct"} mode, ${scope}. Watching for beats…`,
  );

  // Poll for meta.json (pid) — the runner writes it on start.
  const pid = await pollForPid(runDir);

  // /ralph stop may have finalized the record while we polled (it can't kill
  // what it doesn't know the pid of). Don't resurrect a stopped loop — reap
  // the terminal process now that we finally know its pid.
  if (getActiveLoopSync()?.id !== loop.id) {
    if (pid !== null) {
      await killRalphTree(pid).catch(() => {});
      info("ralph: loop stopped during spawn, killed pid", {
        loopId: loop.id,
        pid,
      });
    }
    return false;
  }

  if (pid === null) {
    await updateLoop(loop.id, {
      state: "ended",
      endedAt: new Date().toISOString(),
      endReason: "spawn-failed",
    });
    await reply(
      "❌ Loop did not start (no meta.json after 30s). Check the terminal window.",
    );
    return false;
  }

  loop.pid = pid;
  loop.state = "running";
  await updateLoop(loop.id, { pid, state: "running" });
  startRalphMonitor(api, loop);

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
    // beat repins over it (same pinLatest path), so the pinned message always
    // shows where the loop is at.
    if (res && "messageId" in res) {
      await pinLatest(api, loop, res.messageId);
    }
  }
  info("ralph: started loop", { loopId: loop.id, pid, repo });
  return true;
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
