import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import { readdirSync, readFileSync } from "fs";
import { claudeProjectDir, encodeClaudeProjectDir } from "../paths";
import { encodeProjectPath } from "../sessions/tailer";

const root = (encoded: string) =>
  join(homedir(), ".claude", "projects", encoded);

describe("encodeClaudeProjectDir (single shared encoder)", () => {
  test("encodes every non-alphanumeric char (slash, underscore, dot) as dash", () => {
    expect(encodeClaudeProjectDir("/Users/a/kx_repo/my.app")).toBe(
      "-Users-a-kx-repo-my-app",
    );
  });

  // Regression: tailer's encodeProjectPath used `[/.]` only, missing `_`, so
  // findSessionJsonlPath/history silently failed for any path with an underscore
  // (e.g. kx_repo). It must now match the single shared encoder.
  test("tailer.encodeProjectPath matches the shared encoder (incl. underscores)", () => {
    expect(encodeProjectPath("/Users/a/kx_repo/proj")).toBe(
      encodeClaudeProjectDir("/Users/a/kx_repo/proj"),
    );
    expect(encodeProjectPath("/Users/a/kx_repo/proj")).toBe(
      "-Users-a-kx-repo-proj",
    );
  });
});

describe("claudeProjectDir", () => {
  test("encodes slashes as dashes", () => {
    expect(claudeProjectDir("/Users/a/proj")).toBe(root("-Users-a-proj"));
  });

  // Regression: Claude Code encodes every non-alphanumeric character — not
  // just slashes — so a path segment like `kx_repo` becomes `kx-repo` on disk.
  // The old slash-only encoder pointed at a directory that never exists for
  // any project whose path contains `_` or `.`, so sessionId discovery and
  // backfill silently found nothing.
  test("encodes underscores as dashes", () => {
    expect(claudeProjectDir("/Users/a/kx_repo/kinetix-agents")).toBe(
      root("-Users-a-kx-repo-kinetix-agents"),
    );
  });

  test("encodes dots as dashes", () => {
    expect(claudeProjectDir("/Users/a/my.app")).toBe(root("-Users-a-my-app"));
  });

  test("leaves existing dashes and alphanumerics intact", () => {
    expect(claudeProjectDir("/Users/a/claude-mobile-bridge")).toBe(
      root("-Users-a-claude-mobile-bridge"),
    );
  });
});

describe("encoder guard (WS-5)", () => {
  // The cwd→project-dir encoding has been re-implemented (and drifted) at least
  // four times — each a separate bug when it missed `_`/`.`. This guard fails
  // if any project-dir encoding regex reappears outside paths.ts, forcing every
  // consumer through the single shared encoder.
  const SRC = join(import.meta.dir, "..");
  // Substrings unique to a project-dir encoder (slash/dot/all-non-alnum → dash).
  // Name-slug encoders like `replace(/\s+/g, "-")` are intentionally NOT matched.
  const BANNED = ['[^a-zA-Z0-9]/g, "-"', '[/.]/g, "-"', '/\\//g, "-"'];

  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "__tests__" || e.name === "node_modules") continue;
        out.push(...tsFiles(p));
      } else if (e.name.endsWith(".ts") && e.name !== "paths.ts") {
        out.push(p);
      }
    }
    return out;
  }

  test("no project-dir encoding regex exists outside paths.ts", () => {
    const offenders: string[] = [];
    for (const f of tsFiles(SRC)) {
      const txt = readFileSync(f, "utf-8");
      if (BANNED.some((s) => txt.includes(s))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
