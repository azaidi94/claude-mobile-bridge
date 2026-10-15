/**
 * Bot control socket — a read-only status API for the desktop `bridge` mod
 * (plugins/bridge). A Unix socket in STATE_DIR, mode 0600, so it needs no
 * token: only processes running as this user can connect.
 *
 *   GET /status         → the bot itself and every session it tracks
 *   GET /session/<id>   → one Claude session by sessionId: name + topic
 */

import { chmodSync, unlinkSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "../paths";
import type { SessionInfo } from "../sessions/types";
import type { TopicMapping } from "../topics/topic-store";
import { info, warn } from "../logger";

export const CONTROL_SOCKET = join(STATE_DIR, "bot.sock");

export interface ControlDeps {
  pid: number;
  startedAt: string;
  /** Forum chat id; 0 / undefined before a forum group is adopted. */
  chatId: () => number | undefined;
  sessions: () => SessionInfo[];
  topics: () => TopicMapping[];
}

export interface TopicView {
  topicId: number;
  name: string;
  isOnline: boolean;
  /** t.me deep link; absent when the chat isn't a supergroup. */
  link?: string;
}

/** `https://t.me/c/<id>/<topic>` for a supergroup chat id (`-100<id>`). */
export function topicLink(
  chatId: number | undefined,
  topicId: number,
): string | undefined {
  const m = chatId ? /^-100(\d+)$/.exec(String(chatId)) : null;
  return m ? `https://t.me/c/${m[1]}/${topicId}` : undefined;
}

function viewTopic(t: TopicMapping, chatId: number | undefined): TopicView {
  const link = topicLink(chatId, t.topicId);
  return {
    topicId: t.topicId,
    name: t.sessionName,
    isOnline: t.isOnline,
    ...(link ? { link } : {}),
  };
}

/** Pure router: path → JSON response. */
export function handleControl(
  path: string,
  deps: ControlDeps,
): { status: number; body: unknown } {
  const chatId = deps.chatId() || undefined;
  if (path === "/status") {
    const topics = deps.topics();
    return {
      status: 200,
      body: {
        pid: deps.pid,
        startedAt: deps.startedAt,
        chatId: chatId ?? null,
        sessions: deps.sessions().map((s) => {
          const t = topics.find((m) => m.sessionName === s.name);
          return {
            id: s.id,
            name: s.name,
            dir: s.dir,
            source: s.source,
            topicId: t?.topicId ?? null,
          };
        }),
      },
    };
  }
  const m = /^\/session\/([0-9a-f-]{36})$/i.exec(path);
  if (m) {
    const id = m[1]!;
    const session = deps.sessions().find((s) => s.id === id);
    const topics = deps.topics();
    const topic =
      topics.find((t) => t.sessionId === id) ??
      (session
        ? topics.find((t) => t.sessionName === session.name)
        : undefined);
    return {
      status: 200,
      body: {
        session: session
          ? { name: session.name, dir: session.dir, source: session.source }
          : null,
        topic: topic ? viewTopic(topic, chatId) : null,
      },
    };
  }
  return { status: 404, body: { error: "not found" } };
}

let server: ReturnType<typeof Bun.serve> | null = null;

export function startControlServer(deps: ControlDeps): void {
  try {
    unlinkSync(CONTROL_SOCKET);
  } catch {
    // silently ok: no socket left by a previous run
  }
  // Bind under a 077 umask so the socket is never connectable by others.
  const prevUmask = process.umask(0o077);
  try {
    server = Bun.serve({
      unix: CONTROL_SOCKET,
      fetch(req) {
        if (req.method !== "GET") {
          return Response.json({ error: "method" }, { status: 405 });
        }
        const { status, body } = handleControl(new URL(req.url).pathname, deps);
        return Response.json(body, { status });
      },
    });
    chmodSync(CONTROL_SOCKET, 0o600);
    info("control: socket listening", { socket: CONTROL_SOCKET });
  } catch (err) {
    server?.stop(true);
    server = null;
    warn("control: socket failed — desktop bridge mod sees the bot as down", {
      socket: CONTROL_SOCKET,
      err: String(err),
    });
  } finally {
    process.umask(prevUmask);
  }
}

export function stopControlServer(): void {
  if (!server) return;
  server.stop(true);
  server = null;
  try {
    unlinkSync(CONTROL_SOCKET);
  } catch {
    // silently ok: already gone
  }
}
