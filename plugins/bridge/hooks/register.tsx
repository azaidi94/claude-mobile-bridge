import { atom, read, update } from "claude-code";
import type { Register, StateDollar } from "claude-code";
import type { BridgeStatus, DoctorRun, FeedEntry } from "../types";
import {
  FORMAT_PLUGIN,
  LEGACY_PLUGINS,
  addToFeed,
  bandFor,
  botPidsFrom,
  clockTime,
  doctorLines,
  doctorSummary,
  doctorTone,
  formatDoctor,
  formatStatus,
  bridgeHealth,
  ago,
  pickRelay,
  pidsInCwd,
  statusRows,
  toChannelPrompt,
  type Inbound,
  type RelayPortFile,
  type TopicView,
} from "./core";

/**
 * claude-mobile-bridge inside a Claude session — built for the desktop app,
 * whose sessions can't load channels:
 * - pulls Telegram messages from this session's channel-relay and submits
 *   each as a prompt (the companion bridge-format shows it as `📱 <message>`:
 *   the engine keeps a plugin's own hooks off its submits, so not here);
 * - a band above the prompt when the bridge needs attention;
 * - `/bridge status` and `/bridge doctor`, read from the bot's control socket;
 * - on desktop the band always shows one status line, with details (both,
 *   and the latest phone messages) a press away.
 */

// The relay caps a long-poll at 8s.
const POLL_MS = 8_000;
const RETRY_MS = 5_000;
const STATUS_EVERY_MS = 15_000;
/** A CLI session's relay notifies directly; look again this often in case that changes. */
const CHANNELS_RECHECK_MS = 30_000;
/**
 * An empty answer sooner than this means another poll superseded ours (the
 * relay serves one waiter): back off instead of fighting it in a tight loop.
 */
const SUPERSEDED_MS = POLL_MS / 2;
/** Failed polls in a row before the band says the relay isn't answering. */
const ERRORS_BEFORE_WARN = 3;
const BOT_TIMEOUT_MS = 2_000;
/** Phone messages the expanded band lists (the feed keeps more). */
const BAND_FEED_ROWS = 5;
/** Redraw the band this often, for ages and the startup grace. */
const REDRAW_MS = 30_000;

const status = atom(
  { plugin: "bridge", key: "status" } as const,
  {
    bot: "unknown",
    botPid: null,
    relay: "unknown",
    topic: null,
    lastPhoneAt: null,
    startedAt: 0,
  } as BridgeStatus,
);

const feed = atom(
  { plugin: "bridge", key: "feed" } as const,
  [] as FeedEntry[],
);
/** The band's details shown; this session only, collapsed at start. */
const expanded = atom({ plugin: "bridge", key: "expanded" } as const, false);
const doctorRun = atom(
  { plugin: "bridge", key: "doctor" } as const,
  { at: null, text: null, isRunning: false } as DoctorRun,
);

/**
 * Set fields over the current value (merged inside the update, so concurrent
 * patches from the poll and status timers don't overwrite each other), and
 * skip the write — and the band's redraw — when nothing changed.
 */
const patch = async ($: StateDollar, fields: Partial<BridgeStatus>) => {
  const cur = await read($, status);
  if (JSON.stringify({ ...cur, ...fields }) === JSON.stringify(cur)) return;
  await update($, status, (now) => ({ ...now, ...fields }));
};

export const register: Register = (on) => {
  /**
   * Set by session.start, closing over its `$`: `/bridge doctor`'s checks
   * (the last run kept for the band), and a status check.
   */
  let runDoctor: (() => Promise<string>) | undefined;
  let refreshNow: (() => Promise<void>) | undefined;

  on("session.start", async ($, e, next) => {
    const started = await next(e);
    await $.command.register({
      name: "bridge",
      description: "claude-mobile-bridge: status, or doctor to diagnose",
      argumentHint: "[status|doctor]",
      immediate: true,
    });
    const now = await $.clock.now();
    await patch($, { bot: "unknown", relay: "unknown", startedAt: now });
    // A reload mid-run cancels the run: don't leave "Running…" up.
    await update($, doctorRun, (r) => ({ ...r, isRunning: false }));
    // Ages ("2m ago") and the startup grace change with no state write.
    $.clock.every(REDRAW_MS, () => $.ui.invalidate("ui.render"));

    const home = async () => (await $.env.get("HOME")) ?? "";
    const stateDir = async () =>
      (await $.env.get("CLAUDE_TELEGRAM_STATE_DIR")) ??
      `${await home()}/.claude-mobile-bridge`;

    const findRelay = async (): Promise<RelayPortFile | undefined> => {
      const dir = await stateDir();
      const files = (await $.fs.list(dir)).filter(
        (f) => f.kind === "file" && /^channel-relay-.*\.json$/.test(f.name),
      );
      const ports: RelayPortFile[] = [];
      for (const f of files) {
        try {
          ports.push(JSON.parse(await $.fs.read(`${dir}/${f.name}`)));
        } catch {
          // a port file mid-write or already gone; next pass reads it
        }
      }
      return pickRelay(ports, await $.session.id());
    };

    // ── inbound: pull the relay's inbox ──────────────────────────────────

    let connected: string | undefined;
    let failures = 0;
    let superseded = 0;
    const drop = async (why: string) => {
      if (connected) $.ui.log(`bridge: relay lost (${why})`, { to: "debug" });
      connected = undefined;
      $.ui.status(undefined);
    };

    /** One poll; resolves the delay before the next, or undefined to stop. */
    const tick = async (): Promise<number | undefined> => {
      const relay = await findRelay().catch(() => undefined);
      if (relay?.channelsEnabled) {
        await patch($, { relay: "channels" });
        return CHANNELS_RECHECK_MS;
      }
      if (!relay?.pullSocket) {
        await drop("no relay for this session");
        await patch($, { relay: "none" });
        return RETRY_MS;
      }
      try {
        const t0 = await $.clock.now();
        const res = await $.http.fetch(
          `http://relay/inbox?timeout=${POLL_MS}`,
          { socketPath: relay.pullSocket },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (connected !== relay.pullSocket) {
          connected = relay.pullSocket;
          $.ui.status("📡 telegram");
          $.ui.log(`bridge: polling ${connected}`, { to: "debug" });
        }
        failures = 0;
        const { messages } = JSON.parse(res.text) as { messages: Inbound[] };
        // Submit first: the inbox has handed them over, nothing below may lose them.
        for (const m of messages) {
          void $.prompt
            .submit({ text: toChannelPrompt(m), asUser: true })
            .catch((err) => $.ui.log(`bridge: submit failed: ${err}`));
        }
        const now = await $.clock.now();
        superseded =
          !messages.length && now - t0 < SUPERSEDED_MS ? superseded + 1 : 0;
        // one early return can be a reconnect; two in a row is a second poller
        await patch($, {
          relay: superseded >= 2 ? "contended" : "polling",
          ...(messages.length ? { lastPhoneAt: now } : {}),
        });
        if (messages.length)
          await update($, feed, (list) => addToFeed(list, messages, now)).catch(
            (err) => $.ui.log(`bridge: feed: ${err}`, { to: "debug" }),
          );
        return superseded ? RETRY_MS : 0;
      } catch (err) {
        await drop(String(err));
        if (++failures >= ERRORS_BEFORE_WARN)
          await patch($, { relay: "error" });
        return RETRY_MS;
      }
    };

    // A timer chain, not a loop: the engine drops a module's timers when it
    // reloads, so a reloaded copy never polls alongside the old one.
    const schedule = (ms: number): void => {
      $.clock.after(ms, () => {
        void tick().then(
          (delay) => {
            if (delay !== undefined) schedule(delay);
          },
          (err) => $.ui.log(`bridge: stopped: ${err}`),
        );
      });
    };
    schedule(0);

    // ── bot status, for the band ─────────────────────────────────────────

    const refresh = async () => {
      const known = await askBot<{ topic: TopicView | null }>(
        `/session/${await $.session.id()}`,
      );
      const bot = await askBot<{ pid: number }>("/status");
      await patch($, {
        bot: bot ? "up" : "down",
        botPid: bot?.pid ?? null,
        topic: known?.topic
          ? {
              name: known.topic.name,
              ...(known.topic.link ? { link: known.topic.link } : {}),
            }
          : null,
      });
    };
    /** The bot's answer, or null when it's down or doesn't answer within BOT_TIMEOUT_MS. */
    const askBot = async <T,>(path: string): Promise<T | null> => {
      const ask = (async () => {
        try {
          const res = await $.http.fetch(`http://bot${path}`, {
            socketPath: `${await stateDir()}/bot.sock`,
          });
          return res.ok ? (JSON.parse(res.text) as T) : null;
        } catch {
          return null;
        }
      })();
      const timeout = new Promise<null>((resolve) => {
        $.clock.after(BOT_TIMEOUT_MS, () => resolve(null));
      });
      return Promise.race([ask, timeout]);
    };
    refreshNow = refresh;
    void refresh();
    $.clock.every(STATUS_EVERY_MS, () => void refresh());

    // ── /bridge doctor's I/O ─────────────────────────────────────────────

    const doctor = async () => {
      const sessionId = await $.session.id();
      const [bot, known, relay] = await Promise.all([
        askBot<{ pid: number; cwd?: string | null }>("/status"),
        askBot<{ session: { name: string } | null; topic: TopicView | null }>(
          `/session/${sessionId}`,
        ),
        findRelay().catch(() => undefined),
      ]);
      let botPids = await $.process.run(["ps", "-axo", "pid=,command="]).then(
        (r) => botPidsFrom(r.stdout),
        () => null,
      );
      // Other bun apps run src/index.ts too: keep those in the bot's folder.
      if (botPids?.length && bot?.cwd) {
        const cwd = bot.cwd;
        botPids = await $.process
          .run(["lsof", "-a", "-d", "cwd", "-Fn", "-p", botPids.join(",")])
          .then(
            (r) => pidsInCwd(r.stdout, cwd),
            () => null,
          );
      }
      // merged over user, project and local settings, as the engine reads them
      const enabled = await $.settings.read().then(
        (s) => (s.enabledPlugins ?? {}) as Record<string, unknown>,
        () => null,
      );
      const logDir =
        (await $.env.get("CLAUDE_TELEGRAM_LOG_DIR")) ??
        `${await home()}/Library/Logs/claude-mobile-bridge`;
      const recentErrors = await $.process
        .run(["tail", "-n", "400", `${logDir}/bot.log`])
        .then(
          (r) =>
            r.exitCode === 0
              ? r.stdout
                  .split("\n")
                  .filter((l) => l.includes("[ERROR]"))
                  .slice(-3)
              : null,
          () => null,
        );
      return formatDoctor({
        bot,
        botPids,
        sessionId,
        known,
        relay,
        relayState: (await read($, status)).relay,
        enabledLegacy: enabled
          ? LEGACY_PLUGINS.filter((p) => enabled[p] === true)
          : [],
        formatEnabled: enabled ? enabled[FORMAT_PLUGIN] === true : null,
        recentErrors,
      });
    };
    let inFlight: Promise<string> | undefined;
    /** One run at a time: a second press or `/bridge doctor` shares it. */
    runDoctor = () =>
      (inFlight ??= (async () => {
        try {
          await update($, doctorRun, (r) => ({ ...r, isRunning: true }));
          const text = await doctor().catch(
            (err) => `Bridge doctor failed: ${err}`,
          );
          const now = await $.clock.now();
          await update($, doctorRun, () => ({
            at: now,
            text,
            isRunning: false,
          }));
          return text;
        } finally {
          inFlight = undefined;
          await update($, doctorRun, (r) =>
            r.isRunning ? { ...r, isRunning: false } : r,
          ).catch(() => {});
        }
      })());

    return started;
  });

  on("command.run", { command: "bridge" }, async ($, e) => {
    const arg = e.args.trim();
    if (arg === "doctor") {
      return {
        text: runDoctor
          ? await runDoctor()
          : "Bridge doctor: still starting, try again.",
      };
    }
    if (arg && arg !== "status")
      return { text: "Usage: /bridge [status|doctor]" };
    return { text: formatStatus(await read($, status), await $.clock.now()) };
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const now = await $.clock.now();
    const s = await read($, status);
    const isOpen = await read($, expanded);
    const warning = bandFor(s, now);
    // The desktop app has no status line to glance at: the band stays, one
    // line, there. Elsewhere it shows only when it has something to say.
    if (!warning && !isOpen && e.surface !== "desktop") return next(e);
    const { Box, Text, Button, Link } = $.ui.resolve(e);
    const health = bridgeHealth(s, now);
    const toggle = (
      <Button
        key="details"
        plain
        dimColor
        onPress={() => void update($, expanded, (v) => !v)}
      >
        {isOpen ? "hide ▴" : "details ▾"}
      </Button>
    );
    const summary =
      warning?.tone === "warning" ? (
        <Text color="warning" wrap="wrap">
          {warning.text}
        </Text>
      ) : (
        <Text wrap="truncate">
          <Text color={health.tone}>●</Text>
          <Text dimColor>
            {" "}
            bridge · {health.text}
            {s.topic ? ` · ${s.topic.name}` : ""}
            {s.lastPhoneAt !== null ? ` · 📱 ${ago(now - s.lastPhoneAt)}` : ""}
          </Text>
        </Text>
      );
    const header = (
      <Box flexDirection="row" gap={1} justifyContent="space-between">
        <Box flexShrink={1} flexGrow={1}>
          {summary}
        </Box>
        {toggle}
      </Box>
    );
    if (!isOpen) return header;

    const phone = (await read($, feed)).slice(0, BAND_FEED_ROWS);
    const doc = await read($, doctorRun);
    const rows = statusRows(s, now).map(
      ([k, v]) => [k, k === "topic" && s.topic ? s.topic.name : v] as const,
    );
    const doctor = doctorLines(doc.text);
    return (
      <Box flexDirection="column">
        {header}
        <Box flexDirection="column">
          {rows.map(([k, v]) => (
            <Box key={`row-${k}`} flexDirection="row" gap={1}>
              <Text dimColor mono>
                {k.padEnd(5)}
              </Text>
              <Text wrap="wrap">{v}</Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {s.topic?.link ? (
            <Link href={s.topic.link} label="Open topic" />
          ) : null}
          <Button
            key="doctor"
            variant="primary"
            onPress={() =>
              void runDoctor?.().then((t) => $.ui.toast(doctorSummary(t)))
            }
          >
            {doc.isRunning ? "Running…" : "Run doctor"}
          </Button>
          <Button key="refresh" onPress={() => void refreshNow?.()}>
            Refresh
          </Button>
        </Box>
        {doctor.length ? (
          <Box flexDirection="column">
            <Text dimColor weight="semibold">
              Doctor · {doc.at ? clockTime(doc.at) : ""}
            </Text>
            {doctor.map((l) => {
              const tone = doctorTone(l);
              return (
                <Text wrap="wrap" color={tone} dimColor={!tone}>
                  {tone ? l.trim() : `   ${l.trim()}`}
                </Text>
              );
            })}
          </Box>
        ) : null}
        <Box flexDirection="column">
          <Text dimColor weight="semibold">
            From phone
          </Text>
          {phone.length ? (
            phone.map((m) => (
              <Text wrap="truncate">
                <Text dimColor mono>
                  {clockTime(m.at)}
                </Text>{" "}
                {m.text}
              </Text>
            ))
          ) : (
            <Text dimColor>nothing yet</Text>
          )}
        </Box>
      </Box>
    );
  });
};
