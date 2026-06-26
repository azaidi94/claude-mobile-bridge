import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import { claudeProjectDir } from "../paths";

const root = (encoded: string) =>
  join(homedir(), ".claude", "projects", encoded);

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
