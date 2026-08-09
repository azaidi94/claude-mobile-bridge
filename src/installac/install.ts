/**
 * Pure installer logic for the /installAC command (Task 6 consumes this).
 *
 * Vendors templates/ac-pipeline/ (4 skills + 4 commands + bindings/ralph
 * templates) into a target repo's .claude/. No Telegram/grammY, no network —
 * every path is passed in except templatesRoot(), which is derived from this
 * source file's own location the same way src/handlers/execute.ts locates
 * execute-commands.json.
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

/** <repo>/templates/ac-pipeline, resolved relative to this source file. */
export function templatesRoot(): string {
  return resolve(import.meta.dir, "../../templates/ac-pipeline");
}

function readVersionStamp(path: string): number | null {
  if (!existsSync(path)) return null;
  return parseVersion(readFileSync(path, "utf8"));
}

// Parsed once at import from the vendored templates themselves.
const TEMPLATE_SKILL_PATH = join(
  templatesRoot(),
  "skills/ac-pipeline/SKILL.md",
);
const templateVersion = readVersionStamp(TEMPLATE_SKILL_PATH);
if (templateVersion === null) {
  throw new Error(
    `installac: could not parse ac-pipeline-version from ${TEMPLATE_SKILL_PATH}`,
  );
}
export const TEMPLATE_VERSION: number = templateVersion;

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
    join(templatesRoot(), "bindings.template.md"),
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
    join(templatesRoot(), "ralph-prompt.template.md"),
    join(dir, "prompt_tasks.md"),
  );
}
