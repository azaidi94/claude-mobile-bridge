import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  discoverSkills,
  searchSkills,
  _resetDiscoveryCacheForTesting,
} from "../skills/discovery";
import {
  buildSearch,
  buildLanding,
  buildGroup,
  buildInjectLine,
} from "../handlers/commands/skills";
import { recordUse, _resetSkillRecentsForTesting } from "../skills/recents";

let base: string;
let userDir: string;
let cwd: string;
let prevConfigDir: string | undefined;
let prevRecentsPath: string | undefined;

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function skillFile(dir: string, name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nbody`;
}

beforeEach(() => {
  base = join(tmpdir(), `skills-disc-${Math.random().toString(36).slice(2)}`);
  userDir = join(base, "user-claude");
  cwd = join(base, "project");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = userDir;
  // Isolate recents (buildLanding reads them) to an empty temp path.
  prevRecentsPath = process.env.SKILL_RECENTS_STORE_PATH;
  process.env.SKILL_RECENTS_STORE_PATH = join(base, "recents.json");
  _resetSkillRecentsForTesting();
  _resetDiscoveryCacheForTesting();
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  if (prevRecentsPath === undefined)
    delete process.env.SKILL_RECENTS_STORE_PATH;
  else process.env.SKILL_RECENTS_STORE_PATH = prevRecentsPath;
  rmSync(base, { recursive: true, force: true });
});

describe("discoverSkills", () => {
  test("parses user skill frontmatter (name + description)", () => {
    write(
      join(userDir, "skills", "research", "SKILL.md"),
      skillFile("", "research", "Investigate a question"),
    );
    const entries = discoverSkills(cwd);
    expect(entries).toEqual([
      {
        name: "research",
        description: "Investigate a question",
        origin: "user",
        kind: "skill",
      },
    ]);
  });

  test("derives command name from path; nested dirs become ns:name", () => {
    write(
      join(userDir, "commands", "commit-push.md"),
      `---\ndescription: Commit and push\n---\ngo`,
    );
    write(
      join(cwd, ".claude", "commands", "deploy", "prod.md"),
      `---\ndescription: Ship to prod\n---\ngo`,
    );
    const names = discoverSkills(cwd).map((e) => `${e.name}:${e.origin}`);
    expect(names).toContain("commit-push:user");
    expect(names).toContain("deploy:prod:project");
  });

  test("dedup precedence project > user by name", () => {
    write(
      join(userDir, "skills", "tdd", "SKILL.md"),
      skillFile("", "tdd", "user version"),
    );
    write(
      join(cwd, ".claude", "skills", "tdd", "SKILL.md"),
      skillFile("", "tdd", "project version"),
    );
    const tdd = discoverSkills(cwd).find((e) => e.name === "tdd");
    expect(tdd?.origin).toBe("project");
    expect(tdd?.description).toBe("project version");
  });

  test("resolves plugin skills AND commands via installed_plugins.json", () => {
    const installPath = join(base, "plugin-cache", "expo-app-design", "1.0.0");
    write(
      join(installPath, "skills", "building-ui", "SKILL.md"),
      skillFile("", "building-ui", "Build Expo UI"),
    );
    write(
      join(installPath, "commands", "deploy.md"),
      `---\ndescription: Deploy the app\n---\ngo`,
    );
    write(
      join(userDir, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: { "expo-app-design@expo-plugins": [{ installPath }] },
      }),
    );
    const all = discoverSkills(cwd);
    expect(
      all.find((e) => e.name === "expo-app-design:building-ui"),
    ).toMatchObject({ origin: "plugin", kind: "skill" });
    expect(all.find((e) => e.name === "expo-app-design:deploy")).toMatchObject({
      origin: "plugin",
      kind: "command",
    });
  });

  test("resolves nested plugin skills declared in plugin.json", () => {
    const installPath = join(
      base,
      "plugin-cache",
      "mattpocock-skills",
      "1.2.3",
    );
    write(
      join(installPath, "skills", "engineering", "tdd", "SKILL.md"),
      skillFile("", "tdd", "Test-driven development"),
    );
    // Present on disk but NOT declared — Claude Code won't load it, nor should we.
    write(
      join(installPath, "skills", "in-progress", "loop-me", "SKILL.md"),
      skillFile("", "loop-me", "Work in progress"),
    );
    write(
      join(installPath, ".claude-plugin", "plugin.json"),
      JSON.stringify({ skills: ["./skills/engineering/tdd"] }),
    );
    write(
      join(userDir, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: { "mattpocock-skills@official": [{ installPath }] },
      }),
    );
    const names = discoverSkills(cwd).map((e) => e.name);
    expect(names).toContain("mattpocock-skills:tdd");
    expect(names).not.toContain("mattpocock-skills:loop-me");
  });

  test("declared plugin path may be a container of skill dirs", () => {
    const installPath = join(base, "plugin-cache", "p", "1.0.0");
    write(
      join(installPath, "skills", "engineering", "tdd", "SKILL.md"),
      skillFile("", "tdd", "Test-driven development"),
    );
    write(
      join(installPath, "skills", "engineering", "review", "SKILL.md"),
      skillFile("", "review", "Review changes"),
    );
    write(
      join(installPath, ".claude-plugin", "plugin.json"),
      JSON.stringify({ skills: ["./skills/engineering"] }),
    );
    write(
      join(userDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "p@mkt": [{ installPath }] } }),
    );
    const names = discoverSkills(cwd).map((e) => e.name);
    expect(names).toContain("p:tdd");
    expect(names).toContain("p:review");
  });

  test("declared commands resolve as files and dirs; missing paths skipped", () => {
    const installPath = join(base, "plugin-cache", "p", "1.0.0");
    write(
      join(installPath, "cmds", "ship.md"),
      `---\ndescription: Ship it\n---\ngo`,
    );
    write(
      join(installPath, "more", "deploy", "prod.md"),
      `---\ndescription: Ship to prod\n---\ngo`,
    );
    write(
      join(installPath, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        commands: ["./cmds/ship.md", "./more", "./gone.md", "./nowhere"],
      }),
    );
    write(
      join(userDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "p@mkt": [{ installPath }] } }),
    );
    const cmds = discoverSkills(cwd).filter((e) => e.kind === "command");
    expect(cmds.map((e) => e.name).sort()).toEqual(["p:deploy:prod", "p:ship"]);
  });

  test("malformed plugin.json falls back to the conventional layout", () => {
    const installPath = join(base, "plugin-cache", "p", "1.0.0");
    write(
      join(installPath, "skills", "solo", "SKILL.md"),
      skillFile("", "solo", "Conventional layout"),
    );
    write(join(installPath, ".claude-plugin", "plugin.json"), "{ not json");
    write(
      join(userDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "p@mkt": [{ installPath }] } }),
    );
    expect(discoverSkills(cwd).map((e) => e.name)).toContain("p:solo");
  });

  test("dedup precedence user > plugin by name", () => {
    const installPath = join(base, "plugin-cache", "p", "1.0.0");
    write(
      join(installPath, "skills", "shared", "SKILL.md"),
      skillFile("", "shared", "plugin version"),
    );
    write(
      join(userDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "shared@mkt": [{ installPath }] } }),
    );
    // A user skill named "shared" (matching the plugin's namespaced name).
    write(
      join(userDir, "skills", "shared:shared", "SKILL.md"),
      skillFile("", "shared:shared", "user version"),
    );
    const entry = discoverSkills(cwd).find((e) => e.name === "shared:shared");
    expect(entry).toMatchObject({
      origin: "user",
      description: "user version",
    });
  });

  test("survives a malformed installed_plugins.json without dropping other sources", () => {
    write(
      join(userDir, "skills", "safe", "SKILL.md"),
      skillFile("", "safe", "still here"),
    );
    write(
      join(userDir, "plugins", "installed_plugins.json"),
      `{ not valid json `,
    );
    expect(discoverSkills(cwd).map((e) => e.name)).toContain("safe");
  });

  test("follows symlinked skill dirs (shared skill repos)", () => {
    // Real skill lives outside ~/.claude/skills; a symlink points into it.
    const realDir = join(base, "shared-skills", "linked");
    write(join(realDir, "SKILL.md"), skillFile("", "linked", "via symlink"));
    mkdirSync(join(userDir, "skills"), { recursive: true });
    symlinkSync(realDir, join(userDir, "skills", "linked"));
    const entry = discoverSkills(cwd).find((e) => e.name === "linked");
    expect(entry).toMatchObject({ origin: "user", description: "via symlink" });
  });

  test("re-enumerates after cache expiry (new skills appear)", () => {
    write(
      join(userDir, "skills", "one", "SKILL.md"),
      skillFile("", "one", "first"),
    );
    expect(discoverSkills(cwd)).toHaveLength(1);
    // Same tree within the TTL → cached.
    write(
      join(userDir, "skills", "two", "SKILL.md"),
      skillFile("", "two", "second"),
    );
    expect(discoverSkills(cwd)).toHaveLength(1); // still cached
    // Simulate TTL expiry.
    _resetDiscoveryCacheForTesting();
    expect(
      discoverSkills(cwd)
        .map((e) => e.name)
        .sort(),
    ).toEqual(["one", "two"]);
  });

  test("ignores a lone block-scalar description indicator", () => {
    write(
      join(userDir, "skills", "folded", "SKILL.md"),
      `---\nname: folded\ndescription: >\n---\nbody`,
    );
    const entry = discoverSkills(cwd).find((e) => e.name === "folded");
    expect(entry?.description).toBe("");
  });
});

function callbacks(kb: {
  inline_keyboard: Array<Array<Record<string, unknown>>>;
}): string[] {
  return kb.inline_keyboard
    .flat()
    .map((b) => (typeof b.callback_data === "string" ? b.callback_data : ""))
    .filter(Boolean);
}

describe("buildLanding (cold start)", () => {
  test("with no recents, shows tappable origin-group buttons with counts", async () => {
    write(join(userDir, "skills", "a", "SKILL.md"), skillFile("", "a", "x"));
    write(join(userDir, "skills", "b", "SKILL.md"), skillFile("", "b", "x"));
    write(
      join(cwd, ".claude", "commands", "proj.md"),
      `---\ndescription: p\n---\ngo`,
    );
    _resetDiscoveryCacheForTesting();

    const landing = await buildLanding(cwd);
    const cbs = callbacks(landing.replyMarkup as never);
    // 2 personal + 1 project group; no plugins → no plugin group.
    expect(cbs).toContain("skill:grp:user:0");
    expect(cbs).toContain("skill:grp:project:0");
    expect(cbs.some((c) => c.startsWith("skill:grp:plugin"))).toBe(false);
    const labels = (
      landing.replyMarkup as never as {
        inline_keyboard: Array<Array<{ text?: string }>>;
      }
    ).inline_keyboard
      .flat()
      .map((b) => b.text ?? "");
    expect(labels.some((l) => l.startsWith("⭐ Personal"))).toBe(true);
    expect(landing.text).not.toContain("Recent"); // none yet
  });

  test("with recents: shows them, drops stale names, no empty rows", async () => {
    for (const n of ["one", "two", "three", "four"]) {
      write(join(userDir, "skills", n, "SKILL.md"), skillFile("", n, "x"));
    }
    _resetDiscoveryCacheForTesting();
    // Exactly RECENTS_PER_ROW (3) live recents → the empty-row regression case.
    await recordUse("one");
    await recordUse("two");
    await recordUse("three");
    await recordUse("gone"); // stale: not on disk, must be filtered out

    const landing = await buildLanding(cwd);
    const rows = (
      landing.replyMarkup as never as {
        inline_keyboard: Array<Array<{ callback_data?: string }>>;
      }
    ).inline_keyboard;
    // No empty row wedged in the MIDDLE (the Telegram-reject bug). A single
    // trailing empty row from the group loop is the accepted execute.ts pattern.
    expect(rows.slice(0, -1).every((r) => r.length > 0)).toBe(true);
    const cbs = rows.flat().map((b) => b.callback_data ?? "");
    // 3 recents rendered as skill:run buttons, stale "gone" dropped.
    expect(cbs.filter((c) => c.startsWith("skill:run:"))).toHaveLength(3);
    expect(landing.text).toContain("Recent");
  });
});

describe("buildInjectLine", () => {
  test("no args → bare slash command", () => {
    expect(buildInjectLine("tdd", "")).toBe("/tdd");
  });
  test("appends trimmed args", () => {
    expect(buildInjectLine("code-review", "  high  ")).toBe(
      "/code-review high",
    );
  });
  test("collapses embedded newlines to spaces (no partial submit)", () => {
    expect(buildInjectLine("run", "line1\nline2\r\nline3")).toBe(
      "/run line1 line2 line3",
    );
  });
});

describe("buildGroup (drill-down)", () => {
  beforeEach(() => {
    for (let i = 0; i < 10; i++) {
      write(
        join(userDir, "skills", `u-${i}`, "SKILL.md"),
        skillFile("", `u-${i}`, "x"),
      );
    }
    _resetDiscoveryCacheForTesting();
  });

  test("paginates a group and always offers a Home button", () => {
    const g = buildGroup(cwd, "user", 0)!;
    const cbs = callbacks(g.replyMarkup as never);
    expect(cbs.filter((c) => c.startsWith("skill:run:"))).toHaveLength(8);
    expect(cbs).toContain("skill:grp:user:1"); // Next
    expect(cbs).toContain("skill:home");
  });

  test("returns null for an empty origin", () => {
    expect(buildGroup(cwd, "project", 0)).toBeNull();
  });
});

describe("buildSearch (pagination)", () => {
  beforeEach(() => {
    // 10 skills all matching "task" → 2 pages at PAGE_SIZE 8.
    for (let i = 0; i < 10; i++) {
      write(
        join(userDir, "skills", `task-${i}`, "SKILL.md"),
        skillFile("", `task-${i}`, "a task skill"),
      );
    }
    _resetDiscoveryCacheForTesting();
  });

  test("returns null when nothing matches", () => {
    expect(buildSearch(cwd, "nomatch-xyz", 0)).toBeNull();
  });

  test("page 0 shows PAGE_SIZE results + a Next button", () => {
    const built = buildSearch(cwd, "task", 0)!;
    const rows = built.replyMarkup.inline_keyboard;
    const skillRows = rows.filter((r) =>
      r.some(
        (b) => "callback_data" in b && b.callback_data.startsWith("skill:run:"),
      ),
    );
    expect(skillRows).toHaveLength(8);
    const nav = rows[rows.length - 1]!.map((b) =>
      "callback_data" in b ? b.callback_data : "",
    );
    expect(nav.some((d) => d.startsWith("skill:pg:1:"))).toBe(true);
  });

  test("clamps an out-of-range page to the last page", () => {
    const built = buildSearch(cwd, "task", 99)!;
    const skillRows = built.replyMarkup.inline_keyboard.filter((r) =>
      r.some(
        (b) => "callback_data" in b && b.callback_data.startsWith("skill:run:"),
      ),
    );
    expect(skillRows).toHaveLength(2); // 10 - 8 on the last page
  });
});

describe("searchSkills", () => {
  beforeEach(() => {
    write(
      join(userDir, "skills", "react-architecture", "SKILL.md"),
      skillFile("", "react-architecture", "React conventions"),
    );
    write(
      join(userDir, "skills", "research", "SKILL.md"),
      skillFile("", "research", "Investigate against primary sources"),
    );
    _resetDiscoveryCacheForTesting();
  });

  test("matches on name (case-insensitive)", () => {
    expect(searchSkills(cwd, "REACT").map((e) => e.name)).toEqual([
      "react-architecture",
    ]);
  });

  test("matches on description", () => {
    expect(searchSkills(cwd, "primary").map((e) => e.name)).toEqual([
      "research",
    ]);
  });

  test("empty query returns all", () => {
    expect(searchSkills(cwd, "")).toHaveLength(2);
  });
});
