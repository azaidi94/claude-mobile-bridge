#!/usr/bin/env bun
/**
 * Generate + place the AUQ remote-bridge shared secret in BOTH locations it must
 * live, with the SAME value:
 *   - <repo>/.env              RELAY_AUQ_SECRET=<value>          (read by the bot)
 *   - shell profile            export RELAY_AUQ_SECRET="<value>" (read by the PreToolUse hook)
 *
 * The classic footgun is setting one and not the other, or two different values.
 * This reconciles them: it reuses an existing value if one side already has it,
 * generates one if neither does, and writes the canonical value to both.
 *
 * Idempotent. Secret-bearing files are forced to mode 0600. Backs up the shell
 * profile before editing (the .env is edited in place — a `.env.bak-*` would not
 * be gitignored and could leak the secret).
 *
 * Usage:
 *   bun run setup-auq-secret              # reconcile / create
 *   bun run setup-auq-secret --force-new  # rotate to a brand-new secret
 *   bun run setup-auq-secret ~/.zshrc     # force a specific profile file
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
} from "fs";
import { randomBytes } from "crypto";
import { join, resolve } from "path";

const KEY = "RELAY_AUQ_SECRET";
// What this tool generates (openssl rand -hex 32 / randomBytes(32).hex). A reused
// value that doesn't match is rejected rather than written — see below.
const HEX = /^[0-9a-f]{32,128}$/i;

const HOME = process.env.HOME;
if (!HOME) {
  console.error("setup-auq-secret: $HOME is not set.");
  process.exit(1);
}

const REPO = resolve(import.meta.dir, "..");
const ENV_PATH = join(REPO, ".env");
const args = process.argv.slice(2);
const forceNew = args.includes("--force-new");
const profileArg = args.find((a) => !a.startsWith("-")); // any non-flag arg = profile path

function pickProfile(): string {
  const expand = (p: string) => p.replace(/^~(?=\/|$)/, HOME!);
  if (profileArg) return expand(profileArg);
  if (process.env.RELAY_PROFILE) return expand(process.env.RELAY_PROFILE);
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return join(HOME!, ".zshrc");
  if (shell.includes("bash")) return join(HOME!, ".bash_profile"); // macOS login-shell convention; matches the docs
  return join(HOME!, ".profile");
}

// Never print the secret — only its length. Output may land in a transcript.
const mask = (v: string) => `${"*".repeat(8)} (${v.length} chars)`;
const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");

function readEnvValue(content: string): string {
  const m = content.match(new RegExp(`^${KEY}=(.*)$`, "m"));
  return unquote(m?.[1] ?? "");
}
function readExportValue(content: string): string {
  const m = content.match(new RegExp(`^\\s*export\\s+${KEY}=(.*)$`, "m"));
  return unquote(m?.[1] ?? "");
}

/**
 * Replace EVERY matching line (the regex must be global+multiline so duplicate
 * lines from old manual `echo >>` setups are all normalised, not just the first
 * — otherwise a stale last-wins line could shadow the new value). Appends if no
 * line matches. Uses a function replacement so `$` in the value is never treated
 * as a `String.replace` special pattern.
 */
function upsert(
  content: string,
  re: RegExp,
  line: string,
  header?: string,
): { content: string; changed: boolean } {
  if (re.test(content)) {
    const next = content.replace(re, () => line);
    return { content: next, changed: next !== content };
  }
  const sep = content.length && !content.endsWith("\n") ? "\n" : "";
  const block = (header ? `${header}\n` : "") + line + "\n";
  return { content: content + sep + block, changed: true };
}

// --- .env (create from example if missing) ----------------------------------
let envContent = "";
if (existsSync(ENV_PATH)) {
  envContent = readFileSync(ENV_PATH, "utf8");
} else {
  const example = join(REPO, ".env.example");
  if (existsSync(example)) {
    envContent = readFileSync(example, "utf8");
    console.log(
      "setup-auq-secret: .env not found — created it from .env.example (fill in your other vars).",
    );
  } else {
    console.log("setup-auq-secret: .env not found — creating a new one.");
  }
}

const profilePath = pickProfile();
let profileContent = existsSync(profilePath)
  ? readFileSync(profilePath, "utf8")
  : "";

// --- decide the canonical value ---------------------------------------------
const envVal = readEnvValue(envContent);
const profVal = readExportValue(profileContent);
const conflict = !!envVal && !!profVal && envVal !== profVal && !forceNew;

let value: string;
let source: string;
if (forceNew) {
  value = randomBytes(32).toString("hex");
  source = "generated a new secret (rotated)";
} else if (envVal) {
  value = envVal;
  source = "reused the existing secret from .env";
} else if (profVal) {
  value = profVal;
  source = "reused the existing secret from your shell profile";
} else {
  value = randomBytes(32).toString("hex");
  source = "generated a new secret";
}

// A reused value is attacker-influenced if .env/profile was tampered with: it
// gets written into the shell profile and executes on `source`. Refuse anything
// that isn't the hex format this tool emits. (Freshly generated values pass.)
if (!HEX.test(value)) {
  console.error(
    `setup-auq-secret: the existing ${KEY} doesn't look like a hex secret ` +
      `(expected 32–128 hex chars) — refusing to reuse a possibly-unsafe value.\n` +
      `Re-run with --force-new to generate a fresh one.`,
  );
  process.exit(1);
}

// --- write both -------------------------------------------------------------
const env = upsert(
  envContent,
  new RegExp(`^${KEY}=.*$`, "gm"),
  `${KEY}=${value}`,
);
const prof = upsert(
  profileContent,
  new RegExp(`^\\s*export\\s+${KEY}=.*$`, "gm"),
  `export ${KEY}="${value}"`,
  "# claude-mobile-bridge — AUQ remote-bridge secret (must match .env)",
);

if (env.changed) writeFileSync(ENV_PATH, env.content, { mode: 0o600 });
if (prof.changed) {
  if (existsSync(profilePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${profilePath}.bak-${stamp}`;
    copyFileSync(profilePath, backup);
    chmodSync(backup, 0o600); // the backup captures the old secret — don't leave it world-readable
  }
  writeFileSync(profilePath, prof.content, { mode: 0o600 });
}

// Tighten the secret-bearing files even on no-op runs (e.g. a file that got the
// secret via the old `echo >>` flow at 0644). writeFileSync won't loosen-proof
// an already-existing file, so chmod explicitly.
for (const p of [ENV_PATH, profilePath]) {
  if (existsSync(p)) chmodSync(p, 0o600);
}

// --- report -----------------------------------------------------------------
console.log(`setup-auq-secret: ${source} → ${mask(value)}`);
if (conflict) {
  console.log(
    "  ⚠ .env and your shell profile had DIFFERENT secrets — reconciled both to the .env value.",
  );
}
console.log(
  `  • ${ENV_PATH}: ${env.changed ? "updated (0600)" : "already correct"}`,
);
console.log(
  `  • ${profilePath}: ${prof.changed ? "updated (backed up, 0600)" : "already correct"}`,
);

if (env.changed || prof.changed) {
  console.log("\nNext:");
  console.log(
    `  1. Reload the profile:  source ${profilePath}   (or open a new terminal)`,
  );
  console.log("  2. Restart the bot so it reads the new .env value.");
  console.log(
    "  3. Restart your Claude sessions so the PreToolUse hook sees the exported secret.",
  );
} else {
  console.log("\nAlready configured in both places — nothing to do.");
}
