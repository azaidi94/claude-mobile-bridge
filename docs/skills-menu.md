# `/skills` — browse & inject Claude Code skills/commands

**Status: implemented** (search + recents; args flow included; group-browse deferred).

Surface the Claude Code skills and slash commands available to a session and
inject the chosen one into the live desktop TUI from Telegram. **Search-first**
UX: recents cover the common case, search covers the long tail, group-browse is
the fallback.

## Inject mechanism (locked — verified against code)

A skill/slash command (`/tdd`, `/research`) is intercepted by the Claude Code
CLI, **not** sent to the model. So it must be typed as **keystrokes into the
TUI**, exactly like `/clear`:

- `sendKeysToSession(sctx, "/name" + args)` — `terminal-inject.ts:636`. Sends
  literal text then a separate `Enter` (`buildTmuxSendArgs`), routing per host
  (tmux / cmux / iTerm / Terminal).
- **NOT** `sendViaRelay` — that path (used by `/prompts`) delivers text as a
  _user message to the model_, which would not trigger the slash-command parser.
- Constraint inherited from `inject.ts`: only `sctx.source === "cc"` sessions.
  cmux/cursor get "not supported for X sessions yet."

## Files

| File                              | Status  | Role                                    |
| --------------------------------- | ------- | --------------------------------------- |
| `src/skills/discovery.ts`         | new     | enumerate + parse + dedup + mtime-cache |
| `src/skills/recents.ts`           | ✅ done | persistent LRU of run skills            |
| `src/handlers/commands/skills.ts` | new     | `handleSkills` (landing + search)       |

## 1. Discovery (`discovery.ts`)

```ts
interface SkillEntry {
  name: string; // "tdd", "expo-app-design:building-ui"
  description: string; // frontmatter description
  origin: "user" | "project" | "plugin";
  kind: "skill" | "command";
}
```

Sources, resolved **per session cwd**:

- project commands: `<cwd>/.claude/commands/**/*.md`
- user commands: `~/.claude/commands/**/*.md`
- user skills: `~/.claude/skills/*/SKILL.md`
- project skills: `<cwd>/.claude/skills/*/SKILL.md`
- plugins: read `~/.claude/plugins/installed_plugins.json` → each entry's
  `installPath` → `skills/*/SKILL.md` + `commands/**/*.md`; name = `plugin:skill`.

Rules:

- Command name derived from path under `commands/` minus `.md`; subdirs → `ns:name`.
- Parse YAML frontmatter head for `name` / `description`.
- **Dedup precedence**: project > user > plugin (by name).
- **TTL cache keyed by cwd** (5s) — a dir mtime only bumps on direct add/remove,
  so it misses description edits and nested-file adds; a short TTL picks those
  up while keeping burst taps (paginate/confirm) cheap.
- **Symlinks resolved** — `~/.claude/skills/*` are frequently symlinks into a
  shared skill repo; `Dirent.isDirectory()` is false for those, so both walkers
  fall back to `statSync` (follows links). Missing this dropped 24/37 skills.
- **Built-ins excluded** — they have no markdown source; `/clear`,`/compact`,
  `/context` already have dedicated commands.

## 2. Recents (`recents.ts` — done)

Flat global LRU at `~/.claude-mobile-bridge/skill-recents.json`, env-overridable
via `SKILL_RECENTS_STORE_PATH`. Lazy load, 250ms debounced save, atomic
tmp+rename, `flush()`, test seam. CAP 12. **Filter at render** — intersect with
the current cwd's enumeration so stale names drop off.

## 3. Handler (`skills.ts`) — search-first

- Auth gate (`isAuthorized`).
- Resolve session cwd from `sctx`; if none → `resolveTopicSession(ctx,"skills_pick")`
  (picker in General, like inject). Guard `source === "cc"`.
- **`/skills`** (no arg) → landing (always actionable):
  - **🕘 Recent — two rows**, 3/row, up to 6 (`getRecents()` ∩ available), when any.
  - **Origin-group buttons** — ⭐ Personal / 🧩 Plugins / 📌 Project with counts
    (`skill:grp:<origin>:<page>`), drilling into a paginated list (8/page) with a
    `⌂ Skills` back button (`skill:home`). This is the cold-start entry point —
    a fresh user with no recents still has something to tap.
  - hint: _type `/skills <query>`_.
- **`/skills <query>`** → **substring, case-insensitive** match over
  name+description; one-per-row; paginate 8/page (`◀ Prev` / `Next ▶`); origin
  badge prefix (⭐ user / 📌 project / 🧩 plugin).

## 4. Callback branches (`callback.ts`)

- `skill:run:<idx>` → confirm card: name, badge, full description,
  `[▶ Run /name]` `[✎ With args…]`.
- `skill:go:<idx>` → `sendKeysToSession(sctx,"/name")` → `recordUse(name)` →
  reply `▶ Sent /name → <session>`.
- `skill:args:<idx>` → `force_reply` "args for /name?"; stash pending.
- reply handler → inject `/name <args>`.
- `skill:pg:<n>` (search pagination).
- `<idx>` = index into re-enumerated cwd list (deterministic); validate +
  re-render on miss (files changed between render and tap).

## 5. Args flow (v1)

`✎ With args` → `force_reply` prompt; store `{chatId,threadId,promptMsgId} →
skillName` in-memory; next message whose `reply_to_message.message_id` matches
injects `/name <text>`. Ephemeral in-memory is fine. (No existing `force_reply`
usage in the repo — this is net-new plumbing.)

## 6. Wiring

- `bot.ts`: `bot.command("skills", withSctx(handleSkills))` + callback routing.
- `index.ts`: add `{command:"skills", description:"Browse & run skills"}` to
  `setMyCommands`; add `flushSkillRecents` to `flushStores()` (~line 484, next to
  `flushPrompts`).
- `handlers/index.ts`: export `handleSkills`.

## 7. Tests (`bun run test` — isolated per file)

- discovery: temp `.claude` trees → precedence dedup, frontmatter parse,
  plugin-registry resolution, cwd scoping.
- recents: LRU cap/dedup, persist round-trip via `SKILL_RECENTS_STORE_PATH`,
  filter-at-render drops unavailable names.

## Resolved decisions

- Inject via keystrokes (`sendKeysToSession`), cc-sessions only.
- Search = substring, case-insensitive, name+description.
- Recents = two rows, 3/row, up to 6, filtered to available.
- Built-ins excluded from the catalog.
- **Args in v1** — build the `force_reply` reply-match flow (§5).
- **v1 scope = search + recents**; group-browse deferred.

## Deferred (post-v1)

- Task-based categories (Plan / Build / Ship) instead of origin groups — needs
  skills tagged in frontmatter or by heuristic.
- Telegram inline-query mode (`@bot <q>`) for native type-ahead search.
