/**
 * Pure installer logic for the /installAC command (Task 6 consumes this).
 *
 * Installs the AC pipeline skill set (4 skills + 4 commands + bindings/ralph
 * templates) into a target repo's .claude/. The skill set lives in the
 * standalone peer repo `ac-skills` (a sibling of this checkout, overridable
 * via AC_SKILLS_DIR) — see docs/decisions/2026-08-09-ac-skills-placement.md.
 * No Telegram/grammY, no network — every path is passed in except
 * templatesRoot().
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  copyFileSync,
} from "fs";
import { resolve, join } from "path";

export type AcAnswers = {
  tracker: "jira" | "github" | "none";
  baseBranch: string; // e.g. "main"
  shipPolicy: "pr" | "push-only" | "direct-merge";
  installRalphPrompt: boolean;
};

/** Thrown by writeBindings when `.claude/ac-bindings.md` already exists. */
export class AcBindingsExists extends Error {
  constructor(path: string) {
    super(`ac-bindings.md already exists at ${path}`);
    this.name = "AcBindingsExists";
  }
}

const VERSION_RE = /ac-pipeline-version:\s*(\d+)\s*-->/;

function parseVersion(content: string): number | null {
  const m = content.match(VERSION_RE);
  return m ? Number(m[1]) : null;
}

/**
 * Root of the ac-skills peer repo: AC_SKILLS_DIR env override, else the
 * sibling checkout `../ac-skills` relative to this repo.
 */
export function templatesRoot(): string {
  return (
    process.env.AC_SKILLS_DIR ?? resolve(import.meta.dir, "../../../ac-skills")
  );
}

function readVersionStamp(path: string): number | null {
  if (!existsSync(path)) return null;
  return parseVersion(readFileSync(path, "utf8"));
}

function templateSkillPath(): string {
  return join(templatesRoot(), "skills/ac-pipeline/SKILL.md");
}

/** Whether the ac-skills repo is present and parseable at templatesRoot(). */
export function acSkillsAvailable(): boolean {
  return readVersionStamp(templateSkillPath()) !== null;
}

/**
 * Version of the ac-skills templates. Lazy (read per call) so this module
 * can load in environments without the peer repo (e.g. CI); callers guard
 * with acSkillsAvailable() first.
 */
export function templateVersion(): number {
  const v = readVersionStamp(templateSkillPath());
  if (v === null) {
    throw new Error(
      `installac: ac-skills repo not found or unparseable at ${templatesRoot()} — ` +
        `clone https://github.com/azaidi94/ac-skills as a sibling of this repo, ` +
        `or set AC_SKILLS_DIR`,
    );
  }
  return v;
}

/** Reads the version stamp from <repo>/.claude/skills/ac-pipeline/SKILL.md; null if absent. */
export function installedVersion(repo: string): number | null {
  return readVersionStamp(join(repo, ".claude/skills/ac-pipeline/SKILL.md"));
}

/** Copies skills/* + commands/* from templatesRoot() into <repo>/.claude/, overwriting. */
export function copyTemplates(repo: string): void {
  const root = templatesRoot();
  const claudeDir = join(repo, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  cpSync(join(root, "skills"), join(claudeDir, "skills"), {
    recursive: true,
    force: true,
  });
  cpSync(join(root, "commands"), join(claudeDir, "commands"), {
    recursive: true,
    force: true,
  });
}

const GITIGNORE_ENTRY = ".acp/";

/** Appends ".acp/" to <repo>/.gitignore once. Returns whether it changed anything. */
export function ensureGitignore(repo: string): boolean {
  const path = join(repo, ".gitignore");
  if (!existsSync(path)) {
    writeFileSync(path, `${GITIGNORE_ENTRY}\n`);
    return true;
  }
  const content = readFileSync(path, "utf8");
  const alreadyPresent = content
    .split("\n")
    .some((line) => line.trim() === GITIGNORE_ENTRY);
  if (alreadyPresent) return false;
  const needsNewline = content.length > 0 && !content.endsWith("\n");
  writeFileSync(
    path,
    `${content}${needsNewline ? "\n" : ""}${GITIGNORE_ENTRY}\n`,
  );
  return true;
}

function doneTransition(tracker: AcAnswers["tracker"]): string {
  switch (tracker) {
    case "jira":
      return "tracker transition (attended only)";
    case "github":
      return "close issue (attended only)";
    case "none":
      return "none";
  }
}

/** Renders bindings.template.md with `answers` substituted. */
export function generateBindings(answers: AcAnswers): string {
  const template = readFileSync(
    join(templatesRoot(), "templates/bindings.template.md"),
    "utf8",
  );
  return template
    .replaceAll("{{TRACKER}}", answers.tracker)
    .replaceAll("{{BASE_BRANCH}}", answers.baseBranch)
    .replaceAll("{{SHIP_POLICY}}", answers.shipPolicy)
    .replaceAll("{{DONE_TRANSITION}}", doneTransition(answers.tracker));
}

/** Writes <repo>/.claude/ac-bindings.md. Throws AcBindingsExists if one is already there. */
export function writeBindings(repo: string, answers: AcAnswers): void {
  const dir = join(repo, ".claude");
  const path = join(dir, "ac-bindings.md");
  if (existsSync(path)) throw new AcBindingsExists(path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, generateBindings(answers));
}

/** Copies the static ralph prompt to <repo>/plans/prompt_tasks.md (mkdir -p; overwrite ok). */
export function writeRalphPrompt(repo: string): void {
  const dir = join(repo, "plans");
  mkdirSync(dir, { recursive: true });
  copyFileSync(
    join(templatesRoot(), "templates/ralph-prompt.template.md"),
    join(dir, "prompt_tasks.md"),
  );
}
