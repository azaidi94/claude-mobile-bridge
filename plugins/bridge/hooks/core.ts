import type { BridgeStatus, FeedEntry } from "../types";

/**
 * Pure pieces of the bridge mod: the `<channel>` prompt, port-file
 * choice, and what the band, `/bridge status` and `/bridge doctor` say.
 * register.tsx does the I/O.
 */

export type RelayPortFile = {
  sessionId?: string;
  pullSocket?: string;
  channelsEnabled?: boolean;
  startedAt?: string;
  pid?: number;
};

export type Inbound = { content: string; meta: Record<string, string> };

export type TopicView = { name: string; link?: string };

/** The companion that shows relayed prompts as `📱 <message>` (see plugins/bridge-format). */
export const FORMAT_PLUGIN = "bridge-format@claude-mobile-bridge";

/** Plugins this one replaces; both enabled means two pollers fight over one inbox. */
export const LEGACY_PLUGINS = [
  "channel-pull@claude-mobile-bridge",
  "channel-pull-format@claude-mobile-bridge",
];

const escapeAttr = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The same `<channel>` tag a channels-enabled session sees. A `<channel` or
 * `</channel` inside the message is escaped so the text can't close the tag
 * and forge a second one (another `user=`).
 */
export const toChannelPrompt = (m: Inbound): string => {
  // `source` first and fixed: bridge-format's split expects it, and meta can't override it.
  const { source: _source, ...meta } = m.meta;
  const attrs = Object.entries({ source: "channel-relay", ...meta })
    .map(([k, v]) => `${k}="${escapeAttr(String(v))}"`)
    .join(" ");
  const body = m.content.replace(/<(\/?channel)/gi, "&lt;$1");
  return `<channel ${attrs}>\n${body}\n</channel>`;
};

/** This session's relay: the newest port file naming its id (a SIGKILLed relay leaves a stale one). */
export const pickRelay = (
  ports: RelayPortFile[],
  sessionId: string,
): RelayPortFile | undefined =>
  ports
    .filter((p) => p.sessionId === sessionId)
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0];

/** No warning about a missing relay for this long after start: it's still coming up. */
export const STARTUP_GRACE_MS = 30_000;
/** The band names the topic for this long after a phone message. */
export const RECENT_PHONE_MS = 15 * 60_000;

const ago = (ms: number): string => {
  const m = Math.floor(ms / 60_000);
  return m < 1
    ? "just now"
    : m < 60
      ? `${m}m ago`
      : `${Math.round(m / 60)}h ago`;
};

/** The band's one line, or undefined when there's nothing worth showing. */
export const bandFor = (
  s: BridgeStatus,
  now: number,
): { tone: "warning" | "subtle"; text: string } | undefined => {
  const settled = now - s.startedAt >= STARTUP_GRACE_MS;
  if (s.bot === "down") {
    return {
      tone: "warning",
      text: "⚠️ bridge bot not answering — phone messages wait in Telegram until it's back · /bridge doctor",
    };
  }
  if (s.relay === "contended") {
    return {
      tone: "warning",
      text: "⚠️ two pollers on this session's relay (old channel-pull, or bridge loaded twice) · /bridge doctor",
    };
  }
  if (s.relay === "none" && settled) {
    return {
      tone: "warning",
      text: "⚠️ no channel-relay for this session — the phone can't reach it · /bridge doctor",
    };
  }
  if (s.relay === "error") {
    return {
      tone: "warning",
      text: "⚠️ channel-relay not answering — retrying · /bridge doctor",
    };
  }
  if (s.lastPhoneAt !== null && now - s.lastPhoneAt < RECENT_PHONE_MS) {
    const where = s.topic ? ` in ${s.topic.name}` : "";
    return {
      tone: "subtle",
      text: `📱 phone message${where} · ${ago(now - s.lastPhoneAt)}`,
    };
  }
  return undefined;
};

/** `/bridge status`'s rows (label, text), shared with the pane. */
export const statusRows = (
  s: BridgeStatus,
  now: number,
): [label: "bot" | "topic" | "relay" | "phone", text: string][] => {
  const bot =
    s.bot === "up"
      ? `up${s.botPid ? ` (pid ${s.botPid})` : ""}`
      : s.bot === "down"
        ? "down — no answer on bot.sock"
        : "checking…";
  const relay = {
    polling: "polling (desktop pull inbox)",
    contended:
      "polling, but another poller shares the inbox (old channel-pull, or bridge loaded twice)",
    channels: "channels on — relay notifies directly",
    none: "none found for this session",
    error: "found but not answering — retrying every 5s",
    unknown: "checking…",
  }[s.relay];
  const topic = s.topic
    ? `${s.topic.name}${s.topic.link ? ` — ${s.topic.link}` : ""}`
    : "none yet";
  const phone =
    s.lastPhoneAt === null ? "none here yet" : ago(now - s.lastPhoneAt);
  return [
    ["bot", bot],
    ["topic", topic],
    ["relay", relay],
    ["phone", `last message ${phone}`],
  ];
};

/** `/bridge status`. */
export const formatStatus = (s: BridgeStatus, now: number): string =>
  [
    "Bridge status",
    ...statusRows(s, now).map(([k, v]) => `  ${`${k}:`.padEnd(7)} ${v}`),
  ].join("\n");

/** The pane's headline: one word and its color. */
export const paneHealth = (
  s: BridgeStatus,
  now: number,
): { tone: "success" | "warning" | "error" | "subtle"; text: string } => {
  const settled = now - s.startedAt >= STARTUP_GRACE_MS;
  if (s.bot === "down") return { tone: "error", text: "bot down" };
  if (s.relay === "error" || (s.relay === "none" && settled))
    return { tone: "error", text: "phone can't reach this session" };
  if (s.relay === "contended")
    return { tone: "warning", text: "two pollers on the relay" };
  if (s.bot === "unknown" || s.relay === "unknown" || s.relay === "none")
    return { tone: "subtle", text: "checking…" };
  return { tone: "success", text: "connected" };
};

/** Longest message text the feed keeps. */
export const FEED_TEXT_MAX = 140;
/** Messages the feed keeps. */
export const FEED_MAX = 10;

/** A relayed message as the pane's feed lists it: its first line, cut short. */
export const toFeedEntry = (m: Inbound, at: number): FeedEntry => {
  // by code point, so an emoji at the cut isn't split in half
  const line = [...(m.content.trim().split("\n")[0] ?? "")];
  return {
    at,
    user: m.meta.user ?? null,
    text:
      line.length > FEED_TEXT_MAX
        ? `${line.slice(0, FEED_TEXT_MAX - 1).join("")}…`
        : line.join("") || "(attachment)",
  };
};

/** The feed with one poll's messages (oldest first, as the relay queues them) added: newest first, capped. */
export const addToFeed = (
  list: FeedEntry[],
  messages: Inbound[],
  at: number,
): FeedEntry[] =>
  [...messages.map((m) => toFeedEntry(m, at)).reverse(), ...list].slice(
    0,
    FEED_MAX,
  );

/** A doctor run's lines for the pane: without the header, or the whole text when it failed. */
export const doctorLines = (text: string | null): string[] => {
  if (!text) return [];
  const lines = text.split("\n");
  return lines[0] === "Bridge doctor" ? lines.slice(1) : lines;
};

/** HH:MM, local time. */
export const clockTime = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** A doctor line's color in the pane, by its mark. */
export const doctorTone = (
  line: string,
): "success" | "warning" | "error" | undefined => {
  const l = line.trimStart();
  return l.startsWith("❌") || l.startsWith("Bridge doctor failed")
    ? "error"
    : l.startsWith("⚠️")
      ? "warning"
      : l.startsWith("✅")
        ? "success"
        : undefined;
};

/**
 * Candidate bot pids from `ps -axo pid=,command=`: bun running `src/index.ts`.
 * Any bun app can match; narrow with `pidsInCwd` once the bot's cwd is known.
 */
export const botPidsFrom = (psOut: string): number[] =>
  psOut
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .filter(
      ([, , cmd]) => /\bbun\b/.test(cmd!) && /\bsrc\/index\.ts\b/.test(cmd!),
    )
    .map(([, pid]) => Number(pid));

/** Pids whose cwd is `cwd`, from `lsof -a -d cwd -Fn -p <pids>` (`p<pid>` / `n<path>` lines). */
export const pidsInCwd = (lsofOut: string, cwd: string): number[] => {
  const out: number[] = [];
  let pid: number | undefined;
  for (const l of lsofOut.split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("n") && l.slice(1) === cwd && pid) out.push(pid);
  }
  return out;
};

export type DoctorFacts = {
  /** The bot's /status, or null when the socket didn't answer. */
  bot: { pid: number } | null;
  /**
   * Bot pids from ps; null when ps couldn't run. With the bot up, only those
   * in its cwd; with it down, every `bun … src/index.ts` (maybe not ours).
   */
  botPids: number[] | null;
  sessionId: string;
  /** The bot's /session/<id>; null when the bot didn't answer. */
  known: { session: { name: string } | null; topic: TopicView | null } | null;
  relay: RelayPortFile | undefined;
  relayState: BridgeStatus["relay"];
  enabledLegacy: string[];
  /** bridge-format enabled in settings; null when settings couldn't be read. */
  formatEnabled: boolean | null;
  /** `[ERROR]` lines near the end of bot.log; null when it couldn't be read. */
  recentErrors: string[] | null;
};

/** `/bridge doctor`: one ✅/⚠️/❌ line per check, with what to do. */
export const formatDoctor = (f: DoctorFacts): string => {
  const out: string[] = ["Bridge doctor"];
  const ok = (t: string) => out.push(`  ✅ ${t}`);
  const warn = (t: string) => out.push(`  ⚠️ ${t}`);
  const bad = (t: string) => out.push(`  ❌ ${t}`);

  if (f.bot) {
    ok(`bot answers on bot.sock (pid ${f.bot.pid})`);
    const others = (f.botPids ?? []).filter((p) => p !== f.bot!.pid);
    if (others.length)
      warn(
        `${others.length + 1} bot processes in the bot's folder — the live one is ${f.bot.pid}; stop the others: kill ${others.join(" ")}`,
      );
    else if (f.botPids) ok("one bot process");
  } else if (f.botPids?.length) {
    bad(
      `bot.sock doesn't answer, but \`bun … src/index.ts\` is running (pid ${f.botPids.join(", ")}) — if that's the bot, it predates the control socket: git pull and restart it inside cmux`,
    );
  } else {
    bad(
      "bot doesn't answer on ~/.claude-mobile-bridge/bot.sock and no bot process is running — start `bun run dev` inside cmux",
    );
  }

  if (f.known) {
    if (f.known.session)
      ok(`bot tracks this session as "${f.known.session.name}"`);
    else
      bad(
        `bot doesn't track this session (${f.sessionId}) — its watcher can't see it; look for "session found" in bot.log`,
      );
    if (f.known.topic)
      ok(
        `topic "${f.known.topic.name}"${f.known.topic.link ? ` — ${f.known.topic.link}` : ""}`,
      );
    else warn("no Telegram topic for this session yet");
  }

  if (!f.relay)
    bad(
      "no channel-relay port file names this session — is channel-relay registered as a user MCP server?",
    );
  else if (f.relay.channelsEnabled)
    ok("channel-relay has channels on (CLI session) — no pull needed");
  else if (!f.relay.pullSocket)
    bad(
      "channel-relay offers no pull socket — update the relay (pull it from main)",
    );
  else if (f.relayState === "polling") ok(`polling ${f.relay.pullSocket}`);
  else if (f.relayState === "contended")
    warn(
      `another poller shares ${f.relay.pullSocket} — uninstall channel-pull, or drop the extra bridge copy (a --plugin-dir / dev folder)`,
    );
  else warn(`not polling ${f.relay.pullSocket} yet — retrying every 5s`);

  if (f.enabledLegacy.length)
    warn(
      `${f.enabledLegacy.join(", ")} also enabled — two pollers fight over the inbox; run: ` +
        f.enabledLegacy.map((p) => `claude plugin uninstall ${p}`).join(" && "),
    );

  if (f.formatEnabled === false)
    warn(
      `bridge-format isn't enabled — relayed prompts show their raw <channel> tag; run: claude plugin install ${FORMAT_PLUGIN}`,
    );

  if (f.recentErrors === null) warn("couldn't read bot.log");
  else if (f.recentErrors.length) {
    warn(`recent errors in bot.log (last ${f.recentErrors.length}):`);
    for (const e of f.recentErrors) out.push(`       ${e.slice(0, 200)}`);
  } else ok("no recent errors in bot.log");

  return out.join("\n");
};
