/**
 * Enumerate the Claude Code skills and slash commands available to a session,
 * resolved against that session's working directory.
 *
 * Sources (deduped project > user > plugin by name):
 *   - project commands: <cwd>/.claude/commands/**\/*.md
 *   - user commands:    ~/.claude/commands/**\/*.md
 *   - user skills:      ~/.claude/skills/*\/SKILL.md
 *   - project skills:   <cwd>/.claude/skills/*\/SKILL.md
 *   - plugin skills/cmds: ~/.claude/plugins/installed_plugins.json -> each
 *                         installPath -> skills/*\/SKILL.md + commands/**\/*.md
 *
 * Results are cached per cwd for a few seconds (see CACHE_TTL_MS).
 */

import { readdirSync, readFileSync, statSync, realpathSync } from "fs";
import { join, relative, sep } from "path";
import { homedir } from "os";
import { warn } from "../logger";

export type SkillOrigin = "user" | "project" | "plugin";

export interface SkillEntry {
  /** Invocation name without leading slash, e.g. "tdd" or "expo:building-ui". */
  name: string;
  description: string;
  origin: SkillOrigin;
  kind: "skill" | "command";
}

function userClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Parse the leading `---` frontmatter block for name/description. */
function parseFrontmatter(path: string): {
  name?: string;
  description?: string;
} {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return {};
  }
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = raw.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split("\n")) {
    const m = /^(name|description):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = (m[2] ?? "").trim();
    // A lone block-scalar indicator (`>`, `|`, `>-`, `|+`) has no inline value;
    // the folded content lives on following lines we don't parse — treat as "".
    if (/^[|>][+-]?$/.test(v)) v = "";
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (m[1] === "name") out.name = v;
    else out.description = v;
  }
  return out;
}

/** Recursively collect *.md under `dir`, returning [relativePathNoExt, absPath]. */
function walkCommands(dir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  // We follow symlinks (shared command repos link in), so guard against
  // circular/ancestor links with a visited-realpath set and a depth cap.
  const seen = new Set<string>();
  const MAX_DEPTH = 12;
  const recurse = (cur: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let real: string;
    try {
      real = realpathSync(cur);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(cur, e.name);
      // Skill/command dirs are frequently symlinks (e.g. shared skill repos);
      // Dirent.isDirectory/isFile are false for symlinks, so resolve them.
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const s = statSync(full);
          isDir = s.isDirectory();
          isFile = s.isFile();
        } catch {
          continue; // broken symlink
        }
      }
      if (isDir) recurse(full, depth + 1);
      else if (isFile && e.name.endsWith(".md")) {
        const rel = relative(dir, full).replace(/\.md$/, "");
        out.push([rel.split(sep).join(":"), full]);
      }
    }
  };
  recurse(dir, 0);
  return out;
}

/** Collect immediate skill dirs (each with a SKILL.md) as [dirName, absPath]. */
function walkSkills(dir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let entries: import("fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    // Include symlinked skill dirs (shared skill repos symlink into ~/.claude
    // /skills); the SKILL.md statSync below follows the link and validates it.
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const skillMd = join(dir, e.name, "SKILL.md");
    try {
      if (statSync(skillMd).isFile()) out.push([e.name, skillMd]);
    } catch {
      // no SKILL.md (or broken symlink) in this dir
    }
  }
  return out;
}

function commandEntries(dir: string, origin: SkillOrigin): SkillEntry[] {
  return walkCommands(dir).map(([name, path]) => ({
    name,
    description: parseFrontmatter(path).description ?? "",
    origin,
    kind: "command" as const,
  }));
}

function skillEntries(dir: string, origin: SkillOrigin): SkillEntry[] {
  return walkSkills(dir).map(([dirName, path]) => {
    const fm = parseFrontmatter(path);
    return {
      name: fm.name || dirName,
      description: fm.description ?? "",
      origin,
      kind: "skill" as const,
    };
  });
}

interface InstalledPlugin {
  installPath?: string;
}
interface InstalledPluginsFile {
  plugins?: Record<string, InstalledPlugin[]>;
}

function pluginEntries(): SkillEntry[] {
  const registry = join(userClaudeDir(), "plugins", "installed_plugins.json");
  let parsed: InstalledPluginsFile;
  try {
    parsed = JSON.parse(readFileSync(registry, "utf-8"));
  } catch {
    return [];
  }
  const out: SkillEntry[] = [];
  for (const [key, installs] of Object.entries(parsed.plugins ?? {})) {
    // Strip only the trailing `@marketplace`/`@version`, so npm-scoped keys
    // like `@scope/plugin@1.0.0` keep their scope.
    const pluginName = key.replace(/@[^@]*$/, "") || key;
    if (!Array.isArray(installs)) continue; // hand-edited / format drift
    for (const inst of installs) {
      const base = inst?.installPath;
      if (!base) continue;
      for (const [dirName, path] of walkSkills(join(base, "skills"))) {
        const fm = parseFrontmatter(path);
        out.push({
          name: `${pluginName}:${fm.name || dirName}`,
          description: fm.description ?? "",
          origin: "plugin",
          kind: "skill",
        });
      }
      for (const [name, path] of walkCommands(join(base, "commands"))) {
        out.push({
          name: `${pluginName}:${name}`,
          description: parseFrontmatter(path).description ?? "",
          origin: "plugin",
          kind: "command",
        });
      }
    }
  }
  return out;
}

// Short TTL rather than an mtime signature: a directory's mtime only bumps on
// direct add/remove, so it misses the two common edits — changing a skill's
// description, or adding a nested `commands/foo/new.md`. A few seconds keeps
// burst taps (paginate, confirm) cheap while picking up edits promptly.
const CACHE_TTL_MS = 5000;
const cache = new Map<string, { at: number; entries: SkillEntry[] }>();

/**
 * Enumerate skills/commands available to a session rooted at `cwd`.
 * Deduped project > user > plugin, sorted by name. Cached per cwd for a few
 * seconds so a burst of taps doesn't re-walk the tree each time.
 */
export function discoverSkills(cwd: string): SkillEntry[] {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;

  // Order matters: first writer of a name wins the dedup below.
  const all: SkillEntry[] = [];
  try {
    all.push(...commandEntries(join(cwd, ".claude", "commands"), "project"));
    all.push(...skillEntries(join(cwd, ".claude", "skills"), "project"));
    all.push(...commandEntries(join(userClaudeDir(), "commands"), "user"));
    all.push(...skillEntries(join(userClaudeDir(), "skills"), "user"));
    all.push(...pluginEntries());
  } catch (err) {
    warn(`skill-discovery: enumeration failed: ${err}`);
  }

  const byName = new Map<string, SkillEntry>();
  for (const e of all) if (!byName.has(e.name)) byName.set(e.name, e);
  const entries = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  cache.set(cwd, { at: Date.now(), entries });
  return entries;
}

/** Case-insensitive substring match over name + description. */
export function searchSkills(cwd: string, query: string): SkillEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return discoverSkills(cwd);
  return discoverSkills(cwd).filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q),
  );
}

/** Test seam — clear the per-cwd cache. */
export function _resetDiscoveryCacheForTesting(): void {
  cache.clear();
}
