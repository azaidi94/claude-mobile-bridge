/**
 * /installAC — vendor the ac-pipeline skills/commands into a repo via a
 * short Q&A (tracker, base branch, ship policy, ralph prompt).
 *
 *   /installac <path>   → preflight (exists, git repo), start Q&A
 *   acinstall:<step>:<value>  → callback, one per question (see callback.ts)
 *
 * Consumes the pure installer module (`../../installac/install`) for all
 * filesystem work — this file only owns path resolution, the Q&A state
 * machine, and the final git add/commit.
 */

import { resolve, join } from "path";
import { access, readdir } from "fs/promises";
import { existsSync } from "fs";
import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { getWorkingDir } from "../../settings";
import { isAuthorized } from "../../security";
import { escapeHtml } from "../../formatting";
import { pendingKey } from "../streaming";
import { busReply, tryRealpathSync } from "./helpers";
import { expandHome } from "./ralph";
import {
  TEMPLATE_VERSION,
  installedVersion,
  copyTemplates,
  ensureGitignore,
  writeBindings,
  writeRalphPrompt,
  AcBindingsExists,
  type AcAnswers,
} from "../../installac/install";

const USAGE = [
  "<b>Usage:</b>",
  "<code>/installac &lt;path&gt;</code> — install the AC pipeline into a repo",
].join("\n");

// GIT_* vars that could redirect git at another repo (e.g. a ralph loop or
// another /installac run happening elsewhere on the host). Scrubbed from the
// spawn env so this handler's git calls always act on the target repo.
const GIT_ENV_VARS = [
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
];

/** Drops GIT_* overrides from an env object; keeps everything else as-is. */
export function scrubGitEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (GIT_ENV_VARS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

export type AcStep = "tracker" | "base" | "ship" | "ralph";

interface PendingFlow {
  repo: string;
  step: AcStep;
  answers: Partial<AcAnswers>;
}

// pendingKey(chatId, threadId) -> in-progress /installac flow. Starting a new
// /installac for the same key overwrites (replaces) any pending flow.
const pendingFlows = new Map<string, PendingFlow>();

interface StepConfig {
  step: AcStep;
  question: string;
  options: Array<{ label: string; value: string }>;
}

const STEPS: StepConfig[] = [
  {
    step: "tracker",
    question: "Which issue tracker?",
    options: [
      { label: "Jira", value: "jira" },
      { label: "GitHub", value: "github" },
      { label: "None", value: "none" },
    ],
  },
  {
    step: "base",
    question: "Base branch?",
    options: [
      { label: "main", value: "main" },
      { label: "develop", value: "develop" },
      { label: "master", value: "master" },
    ],
  },
  {
    step: "ship",
    question: "Ship policy?",
    options: [
      { label: "PR", value: "pr" },
      { label: "Push only", value: "push-only" },
      { label: "Direct merge", value: "direct-merge" },
    ],
  },
  {
    step: "ralph",
    question: "Install the ralph prompt (plans/prompt_tasks.md)?",
    options: [
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" },
    ],
  },
];

const STEP_ORDER: AcStep[] = STEPS.map((s) => s.step);

/** tracker -> base -> ship -> ralph -> null (flow complete). */
export function nextAcStep(step: AcStep): AcStep | null {
  const idx = STEP_ORDER.indexOf(step);
  return STEP_ORDER[idx + 1] ?? null;
}

/** Parses `acinstall:<step>:<value>`; null if malformed or an unknown step. */
export function parseAcCallback(
  data: string,
): { step: AcStep; value: string } | null {
  const m = /^acinstall:(tracker|base|ship|ralph):(.+)$/.exec(data);
  if (!m) return null;
  return { step: m[1] as AcStep, value: m[2]! };
}

/** Validates `value` against the step's allowed options and returns the answers patch. */
export function applyAnswer(
  step: AcStep,
  value: string,
): Partial<AcAnswers> | null {
  switch (step) {
    case "tracker":
      if (value !== "jira" && value !== "github" && value !== "none")
        return null;
      return { tracker: value };
    case "base":
      if (value !== "main" && value !== "develop" && value !== "master")
        return null;
      return { baseBranch: value };
    case "ship":
      if (value !== "pr" && value !== "push-only" && value !== "direct-merge")
        return null;
      return { shipPolicy: value };
    case "ralph":
      if (value !== "yes" && value !== "no") return null;
      return { installRalphPrompt: value === "yes" };
  }
}

const ANSWER_LABELS: Record<AcStep, (a: Partial<AcAnswers>) => string | null> =
  {
    tracker: (a) => (a.tracker ? `Tracker: <b>${a.tracker}</b>` : null),
    base: (a) => (a.baseBranch ? `Base branch: <b>${a.baseBranch}</b>` : null),
    ship: (a) => (a.shipPolicy ? `Ship policy: <b>${a.shipPolicy}</b>` : null),
    ralph: (a) =>
      a.installRalphPrompt !== undefined
        ? `Ralph prompt: <b>${a.installRalphPrompt ? "yes" : "no"}</b>`
        : null,
  };

function renderAnswersSoFar(answers: Partial<AcAnswers>): string[] {
  const lines: string[] = [];
  for (const step of STEP_ORDER) {
    const line = ANSWER_LABELS[step](answers);
    if (line) lines.push(`✅ ${line}`);
  }
  return lines;
}

export interface StepButton {
  text: string;
  data: string;
}

export interface StepPrompt {
  text: string;
  buttons: StepButton[];
}

/** Pure prompt builder — grammY-free so it's directly unit-testable. */
export function buildStepPrompt(
  step: AcStep,
  answers: Partial<AcAnswers>,
): StepPrompt {
  const config = STEPS.find((s) => s.step === step)!;
  const answered = renderAnswersSoFar(answers);
  const text = [...answered, `❓ ${config.question}`].join("\n");
  const buttons = config.options.map((o) => ({
    text: o.label,
    data: `acinstall:${step}:${o.value}`,
  }));
  return { text, buttons };
}

function toReplyMarkup(buttons: StepButton[]): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: buttons.map((b) => [
      { text: b.text, callback_data: b.data },
    ]),
  };
}

/** Recursively counts files (not dirs) under `dir`; 0 if it doesn't exist. */
async function countFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, {
      recursive: true,
      withFileTypes: true,
    });
    return entries.filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

export interface SummaryOpts {
  repoLabel: string;
  oldVersion: number | null;
  newVersion: number;
  fileCount: number;
  bindingsWritten: boolean;
  ralphInstalled: boolean;
  committed: boolean;
}

/**
 * Pure error formatter for when finalizeInstall throws mid-way (e.g. an FS
 * error in copyTemplates/writeBindings). The flow is already deleted by the
 * time this runs, so the reply has to point the user back at /installac
 * rather than at a button — there's no live keyboard left to retry through.
 */
export function formatInstallError(repo: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return [
    `❌ <b>Install failed</b> → <code>${escapeHtml(repo)}</code>`,
    escapeHtml(message),
    "",
    `Run <code>/installac ${escapeHtml(repo)}</code> to retry.`,
  ].join("\n");
}

/** Pure summary formatter for the final install/upgrade report. */
export function formatInstallSummary(opts: SummaryOpts): string {
  const versionLine =
    opts.oldVersion === null
      ? `✅ Installed ac-pipeline v${opts.newVersion}`
      : opts.oldVersion === opts.newVersion
        ? `✅ ac-pipeline v${opts.newVersion} already up to date`
        : `✅ Upgraded ac-pipeline v${opts.oldVersion} → v${opts.newVersion}`;
  const bindingsLine = opts.bindingsWritten
    ? "✅ bindings written"
    : "ℹ️ bindings preserved (already present)";
  const ralphLine = opts.ralphInstalled
    ? "✅ ralph prompt installed at <code>plans/prompt_tasks.md</code>"
    : "— ralph prompt skipped";
  const commitLine = opts.committed
    ? "✅ committed"
    : "⚠️ commit failed — check the repo for a dirty working tree";

  const repoTag = escapeHtml(opts.repoLabel);
  const nextSteps = [
    "<b>Next steps:</b>",
    `<code>/new ${repoTag}</code> then <code>/ac &lt;task&gt;</code>`,
  ];
  if (opts.ralphInstalled) {
    nextSteps.push(`<code>/ralph ${repoTag}</code>`);
  }

  return [
    `📦 <b>AC pipeline</b> → <code>${repoTag}</code>`,
    versionLine,
    `📄 ${opts.fileCount} files`,
    bindingsLine,
    ralphLine,
    commitLine,
    "",
    ...nextSteps,
  ].join("\n");
}

export async function handleInstallAc(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  const raw = ctx.message?.text ?? "";
  const argPath = raw.replace(/^\/installac(@\S+)?\s*/, "").trim();
  if (!argPath) {
    await busReply(ctx, `❌ ${USAGE}`, "html");
    return;
  }

  // Resolve relative paths against the configured working dir (~/Dev), matching
  // /ralph and /new — a bare `foo` means <workingDir>/foo, not cwd/foo.
  const repo = tryRealpathSync(resolve(getWorkingDir(), expandHome(argPath)));
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

  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const threadId = ctx.message?.message_thread_id;
  const key = pendingKey(chatId, threadId);
  // Overwrites any flow already pending for this chat+thread (stale-flow
  // handling: starting a new /installac replaces it outright).
  pendingFlows.set(key, { repo, step: "tracker", answers: {} });

  const prompt = buildStepPrompt("tracker", {});
  await busReply(
    ctx,
    `📦 <b>Install AC pipeline</b> → <code>${escapeHtml(repo)}</code>\n\n${prompt.text}`,
    { format: "html", replyMarkup: toReplyMarkup(prompt.buttons) },
  );
}

async function finalizeInstall(
  repo: string,
  answers: AcAnswers,
): Promise<string> {
  const oldVersion = installedVersion(repo);
  copyTemplates(repo);
  ensureGitignore(repo);

  let bindingsWritten = true;
  try {
    writeBindings(repo, answers);
  } catch (err) {
    if (err instanceof AcBindingsExists) {
      bindingsWritten = false;
    } else {
      throw err;
    }
  }

  if (answers.installRalphPrompt) {
    writeRalphPrompt(repo);
  }

  const fileCount =
    (await countFiles(join(repo, ".claude", "skills"))) +
    (await countFiles(join(repo, ".claude", "commands")));

  const addPaths = [".claude", "plans/prompt_tasks.md", ".gitignore"].filter(
    (p) => existsSync(join(repo, p)),
  );
  const env = scrubGitEnv(process.env);
  Bun.spawnSync(["git", "-C", repo, "add", ...addPaths], {
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  // Foreign repos may have their own hooks — not ours to run on their behalf.
  const commit = Bun.spawnSync(
    [
      "git",
      "-C",
      repo,
      "commit",
      "--no-verify",
      "-m",
      `Install AC pipeline skills (ac-pipeline v${TEMPLATE_VERSION}) via /installAC`,
    ],
    { env, stdout: "ignore", stderr: "ignore" },
  );

  return formatInstallSummary({
    repoLabel: repo,
    oldVersion,
    newVersion: TEMPLATE_VERSION,
    fileCount,
    bindingsWritten,
    ralphInstalled: answers.installRalphPrompt,
    committed: commit.exitCode === 0,
  });
}

/** `acinstall:<step>:<value>` callback branch — advances or finalizes the Q&A. */
export async function handleAcInstallCallback(
  ctx: Context,
  data: string,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const threadId = ctx.callbackQuery?.message?.message_thread_id;
  if (chatId === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }

  const key = pendingKey(chatId, threadId);
  const flow = pendingFlows.get(key);
  const parsed = parseAcCallback(data);

  // No pending flow, or the tap doesn't match the flow's current step (a
  // stale button from a replaced/earlier question) — expired.
  if (!flow || !parsed || parsed.step !== flow.step) {
    await ctx.answerCallbackQuery({ text: "expired" });
    return;
  }

  const patch = applyAnswer(parsed.step, parsed.value);
  if (!patch) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }
  flow.answers = { ...flow.answers, ...patch };
  await ctx.answerCallbackQuery().catch(() => {});

  const next = nextAcStep(parsed.step);
  if (next === null) {
    // Deleted up front: the message's keyboard is about to be replaced with
    // a plain "Installing…" status, so there's no live button left for a
    // retry to land on anyway — a failure below sends the user back through
    // /installac from scratch, and leaving a stale entry here would only
    // outlive that for no benefit.
    pendingFlows.delete(key);
    await ctx
      .editMessageText(
        `${renderAnswersSoFar(flow.answers).join("\n")}\n\n⏳ Installing…`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    try {
      const summary = await finalizeInstall(
        flow.repo,
        flow.answers as AcAnswers,
      );
      await busReply(ctx, summary, { format: "html" });
    } catch (err) {
      await busReply(ctx, formatInstallError(flow.repo, err), {
        format: "html",
      });
    }
    return;
  }

  flow.step = next;
  const prompt = buildStepPrompt(next, flow.answers);
  await ctx
    .editMessageText(prompt.text, {
      parse_mode: "HTML",
      reply_markup: toReplyMarkup(prompt.buttons),
    })
    .catch(() => {});
}
