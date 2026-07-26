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

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("afk_tasks_md.sh", () => {
  it("drains a 2-item tasks.md and reports completion", () => {
    const repo = mkdtempSync(join(tmpdir(), "ralph-md-"));
    try {
      // A throwaway git repo with a plans/tasks.md queue.
      git(repo, ["init", "-b", "main"]);
      git(repo, ["config", "user.email", "t@t"]);
      git(repo, ["config", "user.name", "t"]);
      mkdirSync(join(repo, "plans"));
      writeFileSync(
        join(repo, "plans/tasks.md"),
        `# Plan: demo\n\n## [ ] 1. One\n**Depends on:** none\n\n## [ ] 2. Two\n**Depends on:** 1\n`,
      );
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-m", "init"]);

      // Stub `claude`: just signal DONE (the loop machinery owns the rest).
      const bin = join(repo, ".bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "claude"),
        `#!/bin/bash\necho DONE > "$RALPH_SIGNAL"\n`,
      );
      chmodSync(join(bin, "claude"), 0o755);

      const out = execFileSync("bash", [SCRIPT, "5"], {
        cwd: repo,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: "utf8",
      });

      const md = readFileSync(join(repo, "plans/tasks.md"), "utf8");
      expect(md).toContain("## [x] 1. One");
      expect(md).toContain("## [x] 2. Two");
      expect(out).toContain("All issues resolved after");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails fast on a structurally-blocked queue instead of spinning", () => {
    const repo = mkdtempSync(join(tmpdir(), "ralph-md-blocked-"));
    try {
      // A throwaway git repo with a plans/tasks.md queue that can never
      // become eligible: it depends on a nonexistent id.
      git(repo, ["init", "-b", "main"]);
      git(repo, ["config", "user.email", "t@t"]);
      git(repo, ["config", "user.name", "t"]);
      mkdirSync(join(repo, "plans"));
      writeFileSync(
        join(repo, "plans/tasks.md"),
        `# Plan: demo\n\n## [ ] 1. Blocked\n**Depends on:** 9\n`,
      );
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-m", "init"]);

      // Stub `claude`: should never be invoked for a queue-level block.
      const bin = join(repo, ".bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "claude"),
        `#!/bin/bash\necho DONE > "$RALPH_SIGNAL"\n`,
      );
      chmodSync(join(bin, "claude"), 0o755);

      let out = "";
      try {
        out = execFileSync("bash", [SCRIPT, "20"], {
          cwd: repo,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          encoding: "utf8",
        });
      } catch (err: any) {
        out = (err.stdout ?? "") + (err.stderr ?? "");
      }

      expect(out).toContain("Queue blocked");
      expect(out).not.toContain("Reached max iterations");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
