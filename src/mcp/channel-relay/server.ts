#!/usr/bin/env bun
/**
 * Channel Relay MCP Server — bridges our Telegram bot to a running desktop
 * Claude Code session via the channel API.
 *
 * Loaded via: claude --dangerously-load-development-channels channel-relay:./src/mcp/channel-relay
 *
 * Architecture:
 *   Bot ──TCP──► this server ──channel notify──► Desktop Claude
 *       ◄─TCP──              ◄──reply tool call──
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, type Socket } from "net";
import { createHash } from "crypto";
import { execSync } from "child_process";
import {
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { STATE_DIR } from "../../paths";

// ── Port file ──────────────────────────────────────────────────────────

const cwd = process.cwd();
const serverStartedAtMs = Date.now();
const dirHash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
const PORT_FILE = join(
  STATE_DIR,
  `channel-relay-${dirHash}-${process.pid}.json`,
);
const parentSessionId = getParentClaudeSessionId();

mkdirSync(STATE_DIR, { recursive: true });

function writePortFile(port: number): void {
  const data = {
    port,
    pid: process.pid,
    ppid: process.ppid,
    sessionId: parentSessionId,
    cwd,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(PORT_FILE, JSON.stringify(data, null, 2));
}

function removePortFile(): void {
  try {
    unlinkSync(PORT_FILE);
  } catch {}
}

/** Convert a cwd to the Claude projects directory name (slashes → dashes). */
function claudeProjectDir(workingDir: string): string {
  return join(homedir(), ".claude", "projects", workingDir.replace(/\//g, "-"));
}

/** Collect sessionIds already claimed by OTHER relay port files in STATE_DIR. */
function claimedSessionIds(): Set<string> {
  const claimed = new Set<string>();
  try {
    const files = readdirSync(STATE_DIR);
    for (const f of files) {
      if (!f.startsWith("channel-relay-") || !f.endsWith(".json")) continue;
      // Skip our own port file
      const pidPart = f.slice(0, -5).split("-").pop();
      if (pidPart && parseInt(pidPart, 10) === process.pid) continue;
      try {
        const raw = readFileSync(join(STATE_DIR, f), "utf-8");
        const data = JSON.parse(raw) as { sessionId?: string };
        if (data.sessionId) claimed.add(data.sessionId);
      } catch {
        // Malformed — skip
      }
    }
  } catch {
    // STATE_DIR unreadable
  }
  return claimed;
}

/**
 * Scan ~/.claude/projects/<cwd-hash>/ for a JSONL whose birthtime is closest
 * to serverStartedAtMs and not already claimed by another relay instance.
 * Returns the session UUID or undefined.
 */
function discoverSessionId(): string | undefined {
  const projectDir = claudeProjectDir(cwd);
  const claimed = claimedSessionIds();
  let best: { id: string; diff: number } | undefined;

  try {
    const files = readdirSync(projectDir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const id = file.slice(0, -6);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        )
      )
        continue;
      if (claimed.has(id)) continue;
      try {
        const s = statSync(join(projectDir, file));
        // Must have been born no earlier than 30s before relay started
        if (s.birthtimeMs < serverStartedAtMs - 30_000) continue;
        const diff = Math.abs(s.birthtimeMs - serverStartedAtMs);
        if (!best || diff < best.diff) best = { id, diff };
      } catch {
        // stat failed — skip
      }
    }
  } catch {
    // projectDir not yet created — JSONL not written yet, will retry
  }

  return best?.id;
}

/** Re-read port file, merge `updates`, write back. Never clobbers unrelated fields. */
function updateOwnPortFile(updates: Record<string, unknown>): void {
  try {
    const raw = readFileSync(PORT_FILE, "utf-8");
    const current = JSON.parse(raw) as Record<string, unknown>;
    writeFileSync(
      PORT_FILE,
      JSON.stringify({ ...current, ...updates }, null, 2),
    );
  } catch {
    // Port file removed or malformed — ignore
  }
}

const DISCOVERY_RETRY_DELAYS_MS = [3_000, 5_000, 10_000, 20_000, 30_000];

let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
let retryIndex = 0;

function scheduleNextDiscovery(delayMs: number): void {
  if (discoveryTimer) clearTimeout(discoveryTimer);
  discoveryTimer = setTimeout(runDiscovery, delayMs);
}

function runDiscovery(): void {
  discoveryTimer = null;
  const id = discoverSessionId();

  if (id) {
    let currentId: string | undefined;
    try {
      currentId = (
        JSON.parse(readFileSync(PORT_FILE, "utf-8")) as { sessionId?: string }
      ).sessionId;
    } catch {
      return; // Port file gone — stop
    }
    if (id !== currentId) {
      updateOwnPortFile({ sessionId: id });
      process.stderr.write(`channel-relay: discovered sessionId=${id}\n`);
    }
    retryIndex = DISCOVERY_RETRY_DELAYS_MS.length; // switch to 60s steady-state polling
  }

  const delay =
    retryIndex < DISCOVERY_RETRY_DELAYS_MS.length
      ? DISCOVERY_RETRY_DELAYS_MS[retryIndex++]!
      : 60_000;
  scheduleNextDiscovery(delay);
}

function startSessionIdDiscoveryLoop(): void {
  retryIndex = 0;
  scheduleNextDiscovery(DISCOVERY_RETRY_DELAYS_MS[0]!);
}

function extractSessionIdFromArgs(args: string): string | undefined {
  const match = args.match(/(?:^|\s)--session-id\s+(\S+)/);
  return match?.[1];
}

function getParentClaudeSessionId(ppid = process.ppid): string | undefined {
  try {
    const args = execSync(`ps -p ${ppid} -o args=`, {
      encoding: "utf-8",
    }).trim();
    return extractSessionIdFromArgs(args);
  } catch {
    return undefined;
  }
}

// ── TCP server ─────────────────────────────────────────────────────────

let connectedClient: Socket | null = null;

function sendToBot(msg: Record<string, unknown>): boolean {
  if (!connectedClient || connectedClient.destroyed) {
    process.stderr.write(
      `channel-relay: sendToBot failed — bot not connected (type=${msg.type})\n`,
    );
    return false;
  }
  try {
    connectedClient.write(JSON.stringify(msg) + "\n");
    return true;
  } catch (err) {
    process.stderr.write(
      `channel-relay: sendToBot write failed: ${err} (type=${msg.type})\n`,
    );
    return false;
  }
}

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

const tcpServer = createServer((socket) => {
  // Only allow one bot connection at a time
  if (connectedClient && !connectedClient.destroyed) {
    connectedClient.destroy();
  }
  connectedClient = socket;
  process.stderr.write(`channel-relay: bot connected\n`);

  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleBotMessage(msg);
      } catch (err) {
        process.stderr.write(`channel-relay: parse error: ${err}\n`);
      }
    }
  });

  socket.on("close", () => {
    if (connectedClient === socket) connectedClient = null;
    process.stderr.write(`channel-relay: bot disconnected\n`);
  });

  socket.on("error", (err) => {
    process.stderr.write(`channel-relay: socket error: ${err}\n`);
    if (connectedClient === socket) connectedClient = null;
  });
});

// Listen on random port
tcpServer.listen(0, "127.0.0.1", () => {
  const addr = tcpServer.address();
  if (addr && typeof addr !== "string") {
    writePortFile(addr.port);
    process.stderr.write(
      `channel-relay: listening on port ${addr.port} (${PORT_FILE})\n`,
    );
    startSessionIdDiscoveryLoop();
  }
});

// ── Request ID tracking ────────────────────────────────────────────────
// Each channel message gets a unique request_id. The reply tool only works
// with a valid request_id, preventing Claude from using it for terminal input.

let requestCounter = 0;
const validRequestIds = new Map<string, number>(); // id → timestamp
const REQUEST_TTL_MS = 600_000; // 10 min

function generateRequestId(): string {
  return `r${++requestCounter}_${Date.now().toString(36)}`;
}

function pruneExpiredRequests(): void {
  const now = Date.now();
  for (const [id, ts] of validRequestIds) {
    if (now - ts > REQUEST_TTL_MS) validRequestIds.delete(id);
  }
}

// ── Inbound: bot → relay → Claude (channel notification) ──────────────

function handleBotMessage(msg: {
  type: string;
  chat_id?: string;
  user?: string;
  text?: string;
  image_path?: string;
}): void {
  if (msg.type !== "message") return;
  if (!msg.text) {
    process.stderr.write(
      `channel-relay: dropped inbound message with empty text (chat_id=${msg.chat_id || "?"})\n`,
    );
    return;
  }
  pruneExpiredRequests();
  const requestId = generateRequestId();
  const chatId = msg.chat_id || "";
  validRequestIds.set(requestId, Date.now());

  mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: msg.text,
      meta: {
        chat_id: chatId,
        request_id: requestId,
        user: msg.user || "telegram",
        ts: new Date().toISOString(),
        ...(msg.image_path ? { image_path: msg.image_path } : {}),
      },
    },
  });
}

// ── MCP server ─────────────────────────────────────────────────────────

const mcp = new Server(
  { name: "channel-relay", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
      },
    },
    instructions: [
      'Telegram messages arrive as <channel source="channel-relay" chat_id="..." request_id="..." ...>.',
      "Reply using the reply tool — pass BOTH chat_id AND request_id from the channel tag.",
      "Terminal input has no <channel> tag — respond normally as text. Do NOT use the reply tool for terminal input.",
      "The reply tool call IS the response to a relay message. Do NOT also emit the same text (or a paraphrase) as terminal output afterward — that produces a duplicate. Terminal text after a relay reply should only appear if it conveys genuinely new info for the local user.",
    ].join("\n"),
  },
);

// ── Tools: Claude → relay → bot (TCP response) ────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Reply to a Telegram message. Requires request_id and chat_id from the <channel> tag. Will reject invalid request_ids — do NOT use this for terminal input.",
      inputSchema: {
        type: "object" as const,
        properties: {
          request_id: {
            type: "string",
            description:
              "The request_id from the <channel> tag. Required — calls without a valid request_id are rejected.",
          },
          chat_id: { type: "string" },
          text: { type: "string" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Absolute file paths to attach.",
          },
          send_as_pdf: {
            type: "boolean",
            description:
              "Convert the text (markdown) to a styled PDF and send as a document attachment.",
          },
          pdf_filename: {
            type: "string",
            description:
              "Filename for the PDF (e.g. 'quarterly-report'). '.pdf' is appended if missing. Defaults to the first markdown heading.",
          },
        },
        required: ["request_id", "chat_id", "text"],
      },
    },
    {
      name: "edit_message",
      description:
        "Edit a previously sent message. No push notification is triggered.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string" },
          message_id: { type: "string" },
          text: { type: "string" },
        },
        required: ["chat_id", "message_id", "text"],
      },
    },
    {
      name: "react",
      description: "Add an emoji reaction to a Telegram message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string" },
          message_id: { type: "string" },
          emoji: { type: "string" },
        },
        required: ["chat_id", "message_id", "emoji"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const name = req.params.name;

  switch (name) {
    case "reply": {
      const request_id = String(args.request_id || "");
      const chat_id = String(args.chat_id || "");
      const text = String(args.text || "");
      const files = (args.files as string[] | undefined) ?? [];
      const send_as_pdf = Boolean(args.send_as_pdf);
      const pdf_filename = args.pdf_filename
        ? String(args.pdf_filename)
        : undefined;

      // Validate request_id — prevents reply tool being used for terminal input
      if (!validRequestIds.has(request_id)) {
        return errorResult(
          "REJECTED: invalid request_id. This tool is only for responding to <channel> messages. For terminal input, respond normally as text output.",
        );
      }

      // Reject empty-text replies unless files are attached — prevents silent
      // "🔧 channel-relay: reply" placeholder and other empty-send bugs.
      if (!text.trim() && files.length === 0) {
        return errorResult(
          "REJECTED: reply text is empty. Provide a non-empty text field (or attach files). Do not call the reply tool with empty text.",
        );
      }

      validRequestIds.delete(request_id);

      const sent = sendToBot({
        type: "reply",
        chat_id,
        text,
        files,
        send_as_pdf,
        pdf_filename,
      });

      if (!sent) {
        return errorResult(
          `FAILED: reply not delivered — bot connection unavailable (chat_id=${chat_id}). The message was NOT sent to Telegram.`,
        );
      }

      return {
        content: [{ type: "text" as const, text: `Sent reply to ${chat_id}` }],
      };
    }

    case "edit_message": {
      const chat_id = String(args.chat_id || "");
      const message_id = String(args.message_id || "");
      const text = String(args.text || "");

      if (!text.trim()) {
        return errorResult(
          "REJECTED: edit_message text is empty. Provide non-empty replacement text.",
        );
      }

      const sent = sendToBot({
        type: "edit_message",
        chat_id,
        message_id,
        text,
      });
      if (!sent) {
        return errorResult(
          `FAILED: edit not delivered — bot connection unavailable (message_id=${message_id}).`,
        );
      }

      return {
        content: [
          { type: "text" as const, text: `Edited message ${message_id}` },
        ],
      };
    }

    case "react": {
      const chat_id = String(args.chat_id || "");
      const message_id = String(args.message_id || "");
      const emoji = String(args.emoji || "");

      if (!emoji) {
        return errorResult("REJECTED: react emoji is empty.");
      }

      const sent = sendToBot({ type: "react", chat_id, message_id, emoji });
      if (!sent) {
        return errorResult(
          `FAILED: react not delivered — bot connection unavailable (message_id=${message_id}).`,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Reacted with ${emoji} on ${message_id}`,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── Cleanup ────────────────────────────────────────────────────────────

function cleanup(): void {
  if (discoveryTimer) {
    clearTimeout(discoveryTimer);
    discoveryTimer = null;
  }
  removePortFile();
  tcpServer.close();
  if (connectedClient) connectedClient.destroy();
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

// ── Start ──────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  process.stderr.write("channel-relay: MCP server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`channel-relay: fatal: ${err}\n`);
  cleanup();
  process.exit(1);
});
