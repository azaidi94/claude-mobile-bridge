import { test, expect, mock } from "claude-code/testing";
import type { On } from "claude-code";

const HOME = "/home/me";
const DIR = `${HOME}/.claude-mobile-bridge`;
const SOCKET = `${DIR}/relay-42.sock`;
const SID = "a70657a8-a196-46e2-ae7a-f24d92fb4315";

type Host = {
  port: Record<string, unknown>;
  inboxes: string[];
  bot?: { status: unknown; session: unknown };
  ps?: string;
  settings?: unknown;
  log?: string;
};

/** Answers the nouns the mod reads, as a session with one relay and a bot would. */
function fakeHost(on: On, host: Host) {
  const submitted: {
    text: string;
    context?: readonly string[];
    asUser?: boolean;
  }[] = [];
  on("env.get", ($, e) => ({ value: e.name === "HOME" ? HOME : undefined }));
  on("session.id", () => ({ value: SID }));
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("ui.status", () => ({ value: undefined }));
  on("ui.log", () => ({ value: undefined }));
  on("fs.list", () => ({
    value: [
      {
        name: "channel-relay-bbb-42.json",
        kind: "file",
        size: 1,
        mtimeMs: 1,
        isLink: false,
      },
      {
        name: "relay-42.sock",
        kind: "other",
        size: 0,
        mtimeMs: 0,
        isLink: false,
      },
    ] as const,
  }));
  on("fs.read", ($, e) => {
    if (e.path.endsWith("-42.json"))
      return { value: JSON.stringify(host.port) };
    if (e.path === `${HOME}/.claude/settings.json` && host.settings)
      return { value: JSON.stringify(host.settings) };
    throw new Error("ENOENT");
  });
  on("http.fetch", ($, e) => {
    const res = (status: number, body?: unknown) => ({
      value: {
        status,
        ok: status === 200,
        headers: {},
        text: body === undefined ? "" : JSON.stringify(body),
      },
    });
    if (e.init?.socketPath === `${DIR}/bot.sock`) {
      if (!host.bot) throw new Error("ECONNREFUSED");
      return e.url.endsWith("/status")
        ? res(200, host.bot.status)
        : res(200, host.bot.session);
    }
    const body = host.inboxes.shift();
    return body === undefined
      ? res(503)
      : { value: { status: 200, ok: true, headers: {}, text: body } };
  });
  on("process.run", ($, e) => ({
    value:
      e.argv[0] === "ps"
        ? {
            exitCode: 0,
            stdout: host.ps ?? "",
            stderr: "",
            isStdoutTruncated: false,
            isStderrTruncated: false,
          }
        : host.log === undefined
          ? {
              exitCode: 1,
              stdout: "",
              stderr: "no such file",
              isStdoutTruncated: false,
              isStderrTruncated: false,
            }
          : {
              exitCode: 0,
              stdout: host.log,
              stderr: "",
              isStdoutTruncated: false,
              isStderrTruncated: false,
            },
  }));
  on("prompt.submit", ($, e) => {
    submitted.push({
      text: e.text,
      context: e.context,
      asUser: e.origin.kind === "plugin" ? e.origin.asUser : undefined,
    });
    return { text: e.text, context: [] };
  });
  return { submitted };
}

const START = { cwd: "/w", surface: "desktop", isInteractive: true } as const;

/** `/bridge <args>` as typed in the composer. */
const bridge = (
  $: { command: { run: (i: never) => Promise<{ text?: string }> } },
  args: string,
) =>
  $.command.run({
    command: "bridge",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 100 },
  } as never);

test("relays inbox messages as channel-tagged prompts", async ($, on) => {
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  const clock = mock.clock(on);
  const { submitted } = fakeHost(on, {
    port: { sessionId: SID, pullSocket: SOCKET, channelsEnabled: false },
    inboxes: [
      JSON.stringify({
        messages: [
          {
            content: "hi from phone",
            meta: { chat_id: "-100", request_id: "r1", user: "RZA808" },
          },
        ],
      }),
    ],
  });

  await $.session.start(START);
  await clock.settle();

  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toEqual({
    text: '<channel source="channel-relay" chat_id="-100" request_id="r1" user="RZA808">\nhi from phone\n</channel>',
    context: undefined,
    asUser: true,
  });
});

test("stands down when the session already has channels", async ($, on) => {
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  const clock = mock.clock(on);
  const { submitted } = fakeHost(on, {
    port: { sessionId: SID, pullSocket: SOCKET, channelsEnabled: true },
    inboxes: [JSON.stringify({ messages: [{ content: "x", meta: {} }] })],
  });

  await $.session.start({ ...START, surface: "terminal" });
  await clock.advance(60_000);

  expect(submitted).toEqual([]);
});

test("/bridge status reports the bot's topic for this session", async ($, on) => {
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  const clock = mock.clock(on);
  fakeHost(on, {
    port: { sessionId: SID, pullSocket: SOCKET },
    inboxes: [JSON.stringify({ messages: [] })],
    bot: {
      status: { pid: 1646 },
      session: {
        session: { name: "cmb" },
        topic: { name: "cmb", link: "https://t.me/c/1/2" },
      },
    },
  });

  await $.session.start(START);
  await clock.settle();
  const { text } = await bridge($, "");

  expect(text).toContain("bot:    up (pid 1646)");
  expect(text).toContain("topic:  cmb — https://t.me/c/1/2");
  // the fake relay answers 503 after its one scripted poll
  expect(text).toContain("relay:  found but not answering");
});

test("/bridge doctor flags a second bot, old plugins and log errors", async ($, on) => {
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  const clock = mock.clock(on);
  fakeHost(on, {
    port: { sessionId: SID, pullSocket: SOCKET },
    inboxes: [],
    bot: {
      status: { pid: 1646 },
      session: { session: { name: "cmb" }, topic: { name: "cmb" } },
    },
    ps: " 1646 bun --watch run src/index.ts\n55856 bun --watch run src/index.ts\n",
    settings: { enabledPlugins: { "channel-pull@claude-mobile-bridge": true } },
    log: "2026 [INFO] fine\n2026 [ERROR] boom\n",
  });

  await $.session.start(START);
  await clock.settle();
  const { text } = await bridge($, "doctor");

  expect(text).toContain("✅ bot answers on bot.sock (pid 1646)");
  expect(text).toContain("kill 55856");
  expect(text).toContain(
    "claude plugin uninstall channel-pull@claude-mobile-bridge",
  );
  expect(text).toContain("[ERROR] boom");
  expect(text).toContain("bridge-format isn't enabled");
});

test("/bridge doctor when the bot is down", async ($, on) => {
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  const clock = mock.clock(on);
  fakeHost(on, { port: { sessionId: SID, pullSocket: SOCKET }, inboxes: [] });

  await $.session.start(START);
  await clock.settle();
  const { text } = await bridge($, "doctor");
  expect(text).toContain("❌ bot doesn't answer");
  const status = await bridge($, "status");
  expect(status.text).toContain("bot:    down");
});

test("the band warns on every surface when the bot is offline", async ($, on) => {
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  const clock = mock.clock(on);
  fakeHost(on, { port: { sessionId: SID, pullSocket: SOCKET }, inboxes: [] });

  await $.session.start(START);
  await clock.settle();

  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({
      plugin: "bridge",
      surface,
      component: "AbovePrompt",
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 100,
      },
    } as never);
    expect(
      await ui.find({ type: "Text", text: /bridge bot offline/ }),
    ).toBeDefined();
    await ui.unmount();
  }
});
