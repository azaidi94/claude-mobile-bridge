import { atom, read, update } from "claude-code";
import type { Register, StateDollar } from "claude-code";
import type { BridgeStatus } from "../types";
import {
  FORMAT_PLUGIN,
  LEGACY_PLUGINS,
  bandFor,
  botPidsFrom,
  formatDoctor,
  formatStatus,
  pickRelay,
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
 * - `/bridge status` and `/bridge doctor`, read from the bot's control socket.
 */

// The relay caps a long-poll at 8s.
const POLL_MS = 8_000;
const RETRY_MS = 5_000;
const STATUS_EVERY_MS = 15_000;

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

/** Set fields, writing (and so redrawing the band) only on a real change. */
const patch = async ($: StateDollar, fields: Partial<BridgeStatus>) => {
  const cur = await read($, status);
  const next = { ...cur, ...fields };
  if (JSON.stringify(next) !== JSON.stringify(cur))
    await update($, status, () => next);
};

export const register: Register = (on) => {
  /** Set by session.start: `/bridge doctor`'s checks, run with that hook's `$`. */
  let doctor: (() => Promise<string>) | undefined;

  /** Set by session.start: `/bridge doctor`'s checks, run with that hook's `$`. */
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
        return undefined;
      }
      if (!relay?.pullSocket) {
        await drop("no relay for this session");
        await patch($, { relay: "none" });
        return RETRY_MS;
      }
      try {
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
        await patch($, { relay: "polling" });
        const { messages } = JSON.parse(res.text) as { messages: Inbound[] };
        if (messages.length)
          await patch($, { lastPhoneAt: await $.clock.now() });
        for (const m of messages) {
          void $.prompt
            .submit({ text: toChannelPrompt(m), asUser: true })
            .catch((err) => $.ui.log(`bridge: submit failed: ${err}`));
        }
        return 0;
      } catch (err) {
        await drop(String(err));
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
    const askBot = async <T,>(path: string): Promise<T | null> => {
      try {
        const res = await $.http.fetch(`http://bot${path}`, {
          socketPath: `${await stateDir()}/bot.sock`,
        });
        return res.ok ? (JSON.parse(res.text) as T) : null;
      } catch {
        return null;
      }
    };
    void refresh();
    $.clock.every(STATUS_EVERY_MS, () => void refresh());

    // ── /bridge doctor's I/O ─────────────────────────────────────────────

    doctor = async () => {
      const sessionId = await $.session.id();
      const [bot, known, relay] = await Promise.all([
        askBot<{ pid: number }>("/status"),
        askBot<{ session: { name: string } | null; topic: TopicView | null }>(
          `/session/${sessionId}`,
        ),
        findRelay().catch(() => undefined),
      ]);
      const botPids = await $.process.run(["ps", "-axo", "pid=,command="]).then(
        (r) => botPidsFrom(r.stdout),
        () => null,
      );
      const enabled = await $.fs
        .read(`${await home()}/.claude/settings.json`)
        .then(
          (t) =>
            (JSON.parse(t).enabledPlugins ?? {}) as Record<string, boolean>,
        )
        .catch(() => null);
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
        enabledLegacy: enabled ? LEGACY_PLUGINS.filter((p) => enabled[p]) : [],
        formatEnabled: enabled ? !!enabled[FORMAT_PLUGIN] : null,
        recentErrors,
      });
    };

    return started;
  });

  on("command.run", { command: "bridge" }, async ($, e) => {
    const arg = e.args.trim();
    if (arg === "doctor") {
      return {
        text: doctor
          ? await doctor()
          : "Bridge doctor: still starting, try again.",
      };
    }
    if (arg && arg !== "status")
      return { text: "Usage: /bridge [status|doctor]" };
    return { text: formatStatus(await read($, status), await $.clock.now()) };
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const line = bandFor(await read($, status), await $.clock.now());
    if (!line) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return (
      <Box>
        <Text color={line.tone} dimColor={line.tone === "subtle"}>
          {line.text}
        </Text>
      </Box>
    );
  });
};
