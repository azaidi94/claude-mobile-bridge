import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execFileSync } from "child_process";

const SCRIPT = resolve(import.meta.dir, "../../scripts/ralph/afk_tasks_md.sh");

/**
 * A parent process (e.g. a husky pre-commit hook) may have `GIT_DIR`,
 * `GIT_INDEX_FILE`, etc. set to point at the REAL repo. Spawned `git`
 * processes inherit env by default, so those vars override cwd-based repo
 * discovery and cause this test's `git` calls (and the loop script's own
 * `git` calls) to operate on the real repo instead of the tmp one. Scrub
 * them so every spawn in this file is anchored to `cwd`.
 */
function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_PREFIX;
  delete env.GIT_OBJECT_DIRECTORY;
  return env;
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore", env: scrubbedGitEnv() });
}

/**
 * A throwaway git repo holding `tasksMd`, with a stub `claude` on PATH that
 * only signals DONE — the loop machinery owns everything else.
 */
function setupRepo(prefix: string, tasksMd: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  mkdirSync(join(repo, "plans"));
  writeFileSync(join(repo, "plans/tasks.md"), tasksMd);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);

  const bin = join(repo, ".bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/bash\necho DONE > "$RALPH_SIGNAL"\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  return repo;
}

/** Run the loop, returning its combined output whether it exits 0 or not. */
function runLoop(repo: string, iterations: string): string {
  const opts = {
    cwd: repo,
    env: {
      ...scrubbedGitEnv(),
      PATH: `${join(repo, ".bin")}:${process.env.PATH}`,
    },
    encoding: "utf8" as const,
  };
  try {
    return execFileSync("bash", [SCRIPT, iterations], opts);
  } catch (err: any) {
    return (err.stdout ?? "") + (err.stderr ?? "");
  }
}

describe("afk_tasks_md.sh", () => {
  it("drains a 2-item tasks.md and reports completion", () => {
    const repo = setupRepo(
      "ralph-md-",
      `# Plan: demo\n\n## [ ] 1. One\n**Depends on:** none\n\n## [ ] 2. Two\n**Depends on:** 1\n`,
    );
    try {
      const out = runLoop(repo, "5");
      const md = readFileSync(join(repo, "plans/tasks.md"), "utf8");
      expect(md).toContain("## [x] 1. One");
      expect(md).toContain("## [x] 2. Two");
      expect(out).toContain("All issues resolved after");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails fast on a structurally-blocked queue instead of spinning", () => {
    // Depends on a nonexistent id → never eligible; `claude` must never run.
    const repo = setupRepo(
      "ralph-md-blocked-",
      `# Plan: demo\n\n## [ ] 1. Blocked\n**Depends on:** 9\n`,
    );
    try {
      const out = runLoop(repo, "20");
      expect(out).toContain("Queue blocked");
      expect(out).not.toContain("Reached max iterations");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a malformed queue rather than reporting success", () => {
    // `1:` instead of `1.` parses to zero items — which must NOT read as done.
    const repo = setupRepo(
      "ralph-md-malformed-",
      `# Plan: demo\n\n## [ ] 1: One\n**Depends on:** none\n`,
    );
    try {
      const out = runLoop(repo, "5");
      expect(out).toContain("Malformed");
      expect(out).not.toContain("All issues resolved");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses to run on a detached HEAD", () => {
    const repo = setupRepo(
      "ralph-md-detached-",
      `# Plan: demo\n\n## [ ] 1. One\n**Depends on:** none\n`,
    );
    try {
      git(repo, ["checkout", "--detach"]);
      const out = runLoop(repo, "5");
      expect(out).toContain("Detached HEAD");
      expect(out).not.toContain("=== Iteration");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
