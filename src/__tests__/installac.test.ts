import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  acSkillsAvailable,
  templateVersion,
  templatesRoot,
  installedVersion,
  copyTemplates,
  ensureGitignore,
  generateBindings,
  writeBindings,
  writeRalphPrompt,
  AcBindingsExists,
  type AcAnswers,
} from "../installac/install";

const ANSWERS: AcAnswers = {
  tracker: "jira",
  baseBranch: "develop",
  shipPolicy: "pr",
  installRalphPrompt: true,
};

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "installac-"));
}

// These tests exercise the real ac-skills peer repo (sibling checkout or
// AC_SKILLS_DIR). In environments without it (e.g. CI), skip rather than fail.
const available = acSkillsAvailable();
if (!available) {
  console.warn(
    `installac tests skipped: ac-skills repo not found at ${templatesRoot()}`,
  );
}

(available ? describe : describe.skip)("installac/install", () => {
  it("templatesRoot points at a checkout containing the bindings template", () => {
    const root = templatesRoot();
    expect(existsSync(join(root, "templates/bindings.template.md"))).toBe(true);
  });

  it("copyTemplates creates all 4 skills + 4 commands in .claude/", () => {
    const repo = tmpRepo();
    try {
      copyTemplates(repo);
      for (const skill of [
        "ac-pipeline",
        "ac-review",
        "ac-investigate",
        "ac-ideate",
      ]) {
        expect(
          existsSync(join(repo, ".claude/skills", skill, "SKILL.md")),
        ).toBe(true);
      }
      for (const cmd of [
        "ac.md",
        "ac-review.md",
        "ac-investigate.md",
        "ac-ideate.md",
      ]) {
        expect(existsSync(join(repo, ".claude/commands", cmd))).toBe(true);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ensureGitignore appends .acp/ once; second call returns false and leaves the file unchanged", () => {
    const repo = tmpRepo();
    try {
      const first = ensureGitignore(repo);
      expect(first).toBe(true);
      const afterFirst = readFileSync(join(repo, ".gitignore"), "utf8");
      expect(afterFirst).toContain(".acp/");

      const second = ensureGitignore(repo);
      expect(second).toBe(false);
      const afterSecond = readFileSync(join(repo, ".gitignore"), "utf8");
      expect(afterSecond).toBe(afterFirst);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ensureGitignore does not duplicate an existing .acp/ entry from a pre-existing .gitignore", () => {
    const repo = tmpRepo();
    try {
      writeFileSync(join(repo, ".gitignore"), "node_modules/\n.acp/\n");
      const changed = ensureGitignore(repo);
      expect(changed).toBe(false);
      expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(
        "node_modules/\n.acp/\n",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("generateBindings substitutes tracker, base branch, and leaves no {{ placeholders", () => {
    const out = generateBindings(ANSWERS);
    expect(out).toContain("Tracker**: jira");
    expect(out).toContain("origin/develop");
    expect(out).not.toContain("{{");
  });

  it("generateBindings derives done-transition per tracker", () => {
    expect(generateBindings({ ...ANSWERS, tracker: "jira" })).toContain(
      "tracker transition (attended only)",
    );
    expect(generateBindings({ ...ANSWERS, tracker: "github" })).toContain(
      "close issue (attended only)",
    );
    expect(generateBindings({ ...ANSWERS, tracker: "none" })).toContain("none");
  });

  it("installedVersion is null pre-install, TEMPLATE_VERSION post-copy", () => {
    const repo = tmpRepo();
    try {
      expect(installedVersion(repo)).toBeNull();
      copyTemplates(repo);
      expect(installedVersion(repo)).toBe(templateVersion());
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("writeBindings twice throws AcBindingsExists on the second call", () => {
    const repo = tmpRepo();
    try {
      writeBindings(repo, ANSWERS);
      expect(existsSync(join(repo, ".claude/ac-bindings.md"))).toBe(true);
      expect(() => writeBindings(repo, ANSWERS)).toThrow(AcBindingsExists);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("writeRalphPrompt writes plans/prompt_tasks.md, creating dirs and overwriting", () => {
    const repo = tmpRepo();
    try {
      writeRalphPrompt(repo);
      expect(existsSync(join(repo, "plans/prompt_tasks.md"))).toBe(true);
      // overwrite ok
      writeRalphPrompt(repo);
      expect(existsSync(join(repo, "plans/prompt_tasks.md"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
