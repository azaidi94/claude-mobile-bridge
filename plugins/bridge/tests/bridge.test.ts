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
  /** `lsof -Fn` output for the cwd check. */
  lsof?: string;
  settings?: Record<string, unknown>;
  log?: string;
  /** Surfaces attached at start (`$.session.surfaces()`). */
  surfaces?: string[];
  store?: Record<string, unknown>;
};

/** Answers the nouns the mod reads, as a session with one relay and a bot would. */
function fakeHost(on: On, host: Host) {
  const submitted: {
    text: string;
    context?: readonly string[];
    asUser?: boolean;
  }[] = [];
  const opened: string[] = [];
  on("ui.open", ($, e) => {
    opened.push(e.id);
    return { value: { isPlaced: true } };
  });
  on("ui.panes", () => ({
    value: opened.map((id) => ({ id, title: "Bridge" })) as never,
  }));
  on("session.surfaces", () => ({ value: (host.surfaces ?? []) as never }));
  mock.store(on, host.store);
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
    throw new Error("ENOENT");
  });
  on("settings.read", () => ({ value: host.settings ?? {} }));
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
      e.argv[0] === "ps" || e.argv[0] === "lsof"
        ? {
            exitCode: 0,
            stdout: (e.argv[0] === "ps" ? host.ps : host.lsof) ?? "",
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
  return { submitted, opened };
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
  // one 503 after the scripted poll isn't enough to warn
  expect(text).toContain("relay:  polling");
});

test("/bridge doctor flags a second bot, old plugins and log errors", async ($, on) => {
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  const clock = mock.clock(on);
  fakeHost(on, {
    port: { sessionId: SID, pullSocket: SOCKET },
    inboxes: [],
    bot: {
      status: { pid: 1646, cwd: "/w/cmb" },
      session: { session: { name: "cmb" }, topic: { name: "cmb" } },
    },
    // 777 is another bun app's src/index.ts, in another folder
    ps: " 1646 bun --watch run src/index.ts\n55856 bun --watch run src/index.ts\n  777 bun src/index.ts\n",
    lsof: "p1646\nfcwd\nn/w/cmb\np55856\nfcwd\nn/w/cmb\np777\nfcwd\nn/w/other\n",
    settings: { enabledPlugins: { "channel-pull@claude-mobile-bridge": true } },
    log: "2026 [INFO] fine\n2026 [ERROR] boom\n",
  });

  await $.session.start(START);
  await clock.settle();
  const { text } = await bridge($, "doctor");

  expect(text).toContain("✅ bot answers on bot.sock (pid 1646)");
  expect(text).toContain("stop the others: kill 55856\n");
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

test("two pollers on one inbox back off and say so", async ($, on) => {
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  const clock = mock.clock(on);
  // another poller keeps superseding ours: every poll comes back empty at once
  const empty = JSON.stringify({ messages: [] });
  const host = {
    port: { sessionId: SID, pullSocket: SOCKET },
    inboxes: Array.from({ length: 50 }, () => empty),
  };
  fakeHost(on, host);

  await $.session.start(START);
  await clock.advance(20_000);

  // backs off RETRY_MS between polls instead of spinning through the inbox
  expect(50 - host.inboxes.length).toBeLessThanOrEqual(6);
  const { text } = await bridge($, "status");
  expect(text).toContain("another poller shares the inbox");
});

test("one failed poll doesn't warn; it recovers to polling", async ($, on) => {
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  const clock = mock.clock(on);
  const host = {
    port: { sessionId: SID, pullSocket: SOCKET },
    inboxes: [] as string[],
  };
  fakeHost(on, host);

  await $.session.start(START);
  await clock.advance(1); // first poll: 503
  expect((await bridge($, "status")).text).toContain("relay:  checking");
  await clock.advance(20_000); // three failures in a row
  expect((await bridge($, "status")).text).toContain("found but not answering");
  host.inboxes.push(JSON.stringify({ messages: [] }));
  await clock.advance(5_000);
  expect((await bridge($, "status")).text).toContain("relay:  polling");
});

test("the band warns on every surface when the bot is down", async ($, on) => {
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
      await ui.find({ type: "Text", text: /bridge bot not answering/ }),
    ).toBeDefined();
    await ui.unmount();
  }
});

const PANE_PROPS = {
  title: "Bridge",
  isFocused: false,
  bodyColumns: 40,
  placement: "dock",
  scroll: { offset: 0, bodyRows: 30 },
} as never;

const mountPane = (
  $: { ui: { mount: (t: never) => Promise<unknown> } },
  surface: string,
) =>
  $.ui.mount({
    plugin: "bridge",
    surface,
    component: "Pane",
    requestId: "bridge",
    props: PANE_PROPS,
  } as never) as Promise<{
    find: (q: object) => Promise<unknown>;
    press: (t: { key: string }) => Promise<unknown>;
    unmount: () => Promise<void>;
  }>;

const ATTACH = {
  surface: "desktop",
  clientId: "desktop:default",
  viewport: { columns: 120, rows: 40, isFullscreen: true },
} as never;

test("the pane opens when the desktop app attaches, shows the connection and phone messages, and runs doctor", async ($, on) => {
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("session.attach", ($, e) => ({ clientId: e.clientId }));
  const clock = mock.clock(on);
  const { opened } = fakeHost(on, {
    port: { sessionId: SID, pullSocket: SOCKET },
    inboxes: [
      JSON.stringify({
        messages: [
          { content: "run the tests\nplease", meta: { user: "RZA808" } },
        ],
      }),
    ],
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
  expect(opened).toEqual([]);
  await $.session.attach(ATTACH);
  expect(opened).toEqual(["bridge"]);
  // already up: a second attach doesn't open it again
  await $.session.attach(ATTACH);
  expect(opened).toEqual(["bridge"]);

  for (const surface of ["desktop", "terminal", "mobile"]) {
    const ui = await mountPane($, surface);
    expect(await ui.find({ type: "Text", text: /connected/ })).toBeDefined();
    expect(await ui.find({ type: "Link" })).toBeDefined();
    expect(
      await ui.find({ type: "Text", text: /run the tests$/ }),
    ).toBeDefined();
    expect(await ui.find({ type: "Text", text: "not run yet" })).toBeDefined();
    await ui.unmount();
  }

  const ui = await mountPane($, "desktop");
  await ui.press({ key: "doctor" });
  await clock.settle();
  expect(
    await ui.find({ type: "Text", text: /bot answers on bot.sock/ }),
  ).toBeDefined();
  await ui.unmount();
});

test("a session started with the app attached opens the pane", async ($, on) => {
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  const clock = mock.clock(on);
  const { opened } = fakeHost(on, {
    port: { sessionId: SID, pullSocket: SOCKET },
    inboxes: [],
    surfaces: ["terminal", "desktop"],
  });

  await $.session.start(START);
  await clock.settle();
  expect(opened).toEqual(["bridge"]);
});

test("a pane closed by hand stays closed until /bridge pane", async ($, on) => {
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("session.attach", ($, e) => ({ clientId: e.clientId }));
  const clock = mock.clock(on);
  const { opened } = fakeHost(on, {
    port: { sessionId: SID, pullSocket: SOCKET },
    inboxes: [],
    store: { paneClosed: true },
  });

  await $.session.start({ ...START, surface: "terminal" });
  await clock.settle();
  await $.session.attach(ATTACH);
  expect(opened).toEqual([]);
  expect((await bridge($, "pane")).text).toBe("Bridge pane opened.");
  expect(opened).toEqual(["bridge"]);
});
