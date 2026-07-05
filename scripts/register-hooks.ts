#!/usr/bin/env bun
/**
 * Idempotently register the mobile-bridge hook entries in ~/.claude/settings.json:
 *   - PreToolUse / matcher "AskUserQuestion" -> claude-remote-auq-bridge.sh   (AUQ remote bridge)
 *   - SessionStart                            -> claude-remote-session-id.ts  (exact /clear follow)
 *
 * Safe to run repeatedly. Backs up settings.json before any change. Matches
 * existing entries by command *basename*, so it never duplicates regardless of
 * whether the prior path used ~, an absolute path, or a different username.
 *
 * Both hooks no-op when the bot/secret is absent (the AUQ bridge falls back to
 * the local TUI; SessionStart only writes to its own log), so registering them
 * by default is additive — nothing breaks if you never enable the bridge.
 *
 * Run via `bun run register-hooks` (also invoked by `bun run install-hooks`).
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
} from "fs";
import { join, dirname } from "path";

const HOME = process.env.HOME;
if (!HOME) {
  console.error(
    "register-hooks: $HOME is not set; cannot locate ~/.claude/settings.json",
  );
  process.exit(1);
}

const SETTINGS = join(HOME, ".claude", "settings.json");
const HOOKS_DIR = join(HOME, ".claude", "hooks");

type HookCmd = { type: "command"; command: string };
type HookEntry = { matcher?: string; hooks: HookCmd[] };

const AUQ_BRIDGE = "claude-remote-auq-bridge.sh";
const SESSION_ID = "claude-remote-session-id.ts";

const basename = (p: string) => p.split("/").pop() ?? p;
const isObject = (v: unknown): v is Record<string, any> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// --- load -------------------------------------------------------------------
let settings: Record<string, any> = {};
let existed = false;
if (existsSync(SETTINGS)) {
  existed = true;
  const raw = readFileSync(SETTINGS, "utf8");
  try {
    settings = JSON.parse(raw);
  } catch (err) {
    console.error(
      `register-hooks: ${SETTINGS} is not valid JSON — refusing to touch it.\n` +
        `Fix the file by hand, then re-run. (${(err as Error).message})`,
    );
    process.exit(1);
  }
  if (!isObject(settings)) {
    console.error(
      `register-hooks: ${SETTINGS} is not a JSON object — refusing to touch it.`,
    );
    process.exit(1);
  }
}

if (settings.hooks !== undefined && !isObject(settings.hooks)) {
  console.error(
    `register-hooks: "hooks" in ${SETTINGS} is not an object — refusing to touch it.`,
  );
  process.exit(1);
}
settings.hooks ??= {};
const hooks = settings.hooks as Record<string, unknown>;
// Coerce the two groups to arrays — a hand-edited file may have an object or
// other shape where we expect an array; `entries.some(...)` would otherwise throw.
for (const key of ["PreToolUse", "SessionStart"]) {
  if (!Array.isArray(hooks[key])) hooks[key] = [];
}
const preToolUse = hooks.PreToolUse as HookEntry[];
const sessionStart = hooks.SessionStart as HookEntry[];

let mutated = false;
const log: string[] = [];

const hasCommand = (entries: HookEntry[], name: string): boolean =>
  entries.some((e) =>
    (e?.hooks ?? []).some((h) => basename(h.command) === name),
  );

// --- PreToolUse / AskUserQuestion -> AUQ bridge -----------------------------
if (hasCommand(preToolUse, AUQ_BRIDGE)) {
  log.push(`PreToolUse[AskUserQuestion] -> ${AUQ_BRIDGE}: already present`);
} else {
  const cmd: HookCmd = {
    type: "command",
    command: join(HOOKS_DIR, AUQ_BRIDGE),
  };
  const existing = preToolUse.find((e) => e.matcher === "AskUserQuestion");
  if (existing) (existing.hooks ??= []).push(cmd);
  else preToolUse.push({ matcher: "AskUserQuestion", hooks: [cmd] });
  mutated = true;
  log.push(`PreToolUse[AskUserQuestion] -> ${AUQ_BRIDGE}: added`);
}

// --- SessionStart -> session-id reporter ------------------------------------
if (hasCommand(sessionStart, SESSION_ID)) {
  log.push(`SessionStart -> ${SESSION_ID}: already present`);
} else {
  const cmd: HookCmd = {
    type: "command",
    command: join(HOOKS_DIR, SESSION_ID),
  };
  // Prefer a matcher-less SessionStart group (the canonical shape); else create one.
  const existing = sessionStart.find((e) => e.matcher === undefined);
  if (existing) (existing.hooks ??= []).push(cmd);
  else sessionStart.push({ hooks: [cmd] });
  mutated = true;
  log.push(`SessionStart -> ${SESSION_ID}: added`);
}

// --- write (only if something actually changed) -----------------------------
if (!mutated) {
  console.log("register-hooks: nothing to do — both hooks already registered.");
  for (const c of log) console.log(`  • ${c}`);
  process.exit(0);
}

if (existed) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${SETTINGS}.bak-${stamp}`;
  copyFileSync(SETTINGS, backup);
  console.log(`register-hooks: backed up ${SETTINGS} -> ${backup}`);
} else {
  mkdirSync(dirname(SETTINGS), { recursive: true }); // standalone run before ~/.claude exists
}

writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
console.log(`register-hooks: updated ${SETTINGS}`);
for (const c of log) console.log(`  • ${c}`);
console.log(
  "\nRestart your Claude sessions so they load the hooks (no hot-reload). " +
    "The bot reloads on its own.",
);
