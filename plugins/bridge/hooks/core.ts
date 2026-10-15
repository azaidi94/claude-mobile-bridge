import type { BridgeStatus } from "../types";

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

/** Plugins this one replaces; both enabled means every message lands twice. */
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
  const attrs = Object.entries({ source: "channel-relay", ...m.meta })
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
      text: "⚠️ bridge bot offline — phone messages wait up to 10 min · /bridge doctor",
    };
  }
  if ((s.relay === "none" || s.relay === "error") && settled) {
    return {
      tone: "warning",
      text: "⚠️ no channel-relay for this session — the phone can't reach it · /bridge doctor",
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

/** `/bridge status`. */
export const formatStatus = (s: BridgeStatus, now: number): string => {
  const bot =
    s.bot === "up"
      ? `up${s.botPid ? ` (pid ${s.botPid})` : ""}`
      : s.bot === "down"
        ? "down — no answer on bot.sock"
        : "checking…";
  const relay = {
    polling: "polling (desktop pull inbox)",
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
    "Bridge status",
    `  bot:    ${bot}`,
    `  topic:  ${topic}`,
    `  relay:  ${relay}`,
    `  phone:  last message ${phone}`,
  ].join("\n");
};

/** Bot pids from `ps -axo pid=,command=` (the bot runs `src/index.ts` under bun). */
export const botPidsFrom = (psOut: string): number[] =>
  psOut
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .filter(
      ([, , cmd]) => /\bbun\b/.test(cmd!) && /\bsrc\/index\.ts\b/.test(cmd!),
    )
    .map(([, pid]) => Number(pid));

export type DoctorFacts = {
  /** The bot's /status, or null when the socket didn't answer. */
  bot: { pid: number } | null;
  /** Bot pids from ps; null when ps couldn't run. */
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

  if (f.bot) ok(`bot answers on bot.sock (pid ${f.bot.pid})`);
  else
    bad(
      "bot doesn't answer on ~/.claude-mobile-bridge/bot.sock — start `bun run dev` inside cmux",
    );

  if (f.botPids && f.botPids.length > 1) {
    const others = f.botPids.filter((p) => p !== f.bot?.pid);
    warn(
      `${f.botPids.length} bot processes (${f.botPids.join(", ")})` +
        (f.bot
          ? ` — the live one is ${f.bot.pid}; stop the others: kill ${others.join(" ")}`
          : ""),
    );
  } else if (f.botPids) ok("one bot process");

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
  else warn(`not polling ${f.relay.pullSocket} yet — retrying every 5s`);

  if (f.enabledLegacy.length)
    warn(
      `${f.enabledLegacy.join(", ")} also enabled — phone messages arrive twice; run: ` +
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
