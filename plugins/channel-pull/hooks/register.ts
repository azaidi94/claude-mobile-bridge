import type { Register } from "claude-code";

/**
 * Pulls Telegram messages from this session's channel-relay and submits each
 * as a prompt, for sessions that can't receive channel notifications (the
 * Claude desktop app). The relay only offers the pull socket when its parent
 * claude runs without channels, so a CLI `cc` session is left alone.
 */

type RelayPortFile = {
  sessionId?: string;
  pullSocket?: string;
  channelsEnabled?: boolean;
  startedAt?: string;
};

type Inbound = { content: string; meta: Record<string, string> };

// The relay caps a long-poll at 8s.
const POLL_MS = 8_000;
const RETRY_MS = 5_000;

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

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const started = await next(e);

    const findRelay = async (): Promise<RelayPortFile | undefined> => {
      const dir =
        (await $.env.get("CLAUDE_TELEGRAM_STATE_DIR")) ??
        `${await $.env.get("HOME")}/.claude-mobile-bridge`;
      const sessionId = await $.session.id();
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
      return pickRelay(ports, sessionId);
    };

    let connected: string | undefined;
    const drop = (why: string) => {
      if (connected)
        $.ui.log(`channel-pull: relay lost (${why})`, { to: "debug" });
      connected = undefined;
      $.ui.status(undefined);
    };

    /** One poll; resolves the delay before the next, or undefined to stop. */
    const tick = async (): Promise<number | undefined> => {
      const relay = await findRelay().catch(() => undefined);
      if (relay?.channelsEnabled) {
        $.ui.log("channel-pull: channels enabled, relay notifies directly", {
          to: "debug",
        });
        return undefined;
      }
      if (!relay?.pullSocket) {
        drop("no relay for this session");
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
          $.ui.log(`channel-pull: polling ${connected}`, { to: "debug" });
        }
        const { messages } = JSON.parse(res.text) as { messages: Inbound[] };
        for (const m of messages) {
          void $.prompt
            .submit({ text: toChannelPrompt(m), asUser: true })
            .catch((err) => $.ui.log(`channel-pull: submit failed: ${err}`));
        }
        return 0;
      } catch (err) {
        drop(String(err));
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
          (err) => $.ui.log(`channel-pull: stopped: ${err}`),
        );
      });
    };
    schedule(0);
    return started;
  });
};
