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
import { writeFileSync, unlinkSync, realpathSync } from "fs";
import { homedir } from "os";

// ── Port file ──────────────────────────────────────────────────────────

const cwd = process.cwd();
const dirHash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
const PORT_FILE = `/tmp/channel-relay-${dirHash}-${process.pid}.json`;

function writePortFile(port: number): void {
  const data = {
    port,
    pid: process.pid,
    ppid: process.ppid,
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

// ── TCP server ─────────────────────────────────────────────────────────

let connectedClient: Socket | null = null;

function sendToBot(msg: Record<string, unknown>): void {
  if (!connectedClient || connectedClient.destroyed) return;
  connectedClient.write(JSON.stringify(msg) + "\n");
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
  if (msg.type === "message" && msg.text) {
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

      // Validate request_id — prevents reply tool being used for terminal input
      if (!validRequestIds.has(request_id)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "REJECTED: invalid request_id. This tool is only for responding to <channel> messages. For terminal input, respond normally as text output.",
            },
          ],
          isError: true,
        };
      }
      validRequestIds.delete(request_id);

      sendToBot({ type: "reply", chat_id, text, files });

      return {
        content: [{ type: "text" as const, text: `Sent reply to ${chat_id}` }],
      };
    }

    case "edit_message": {
      const chat_id = String(args.chat_id || "");
      const message_id = String(args.message_id || "");
      const text = String(args.text || "");

      sendToBot({ type: "edit_message", chat_id, message_id, text });

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

      sendToBot({ type: "react", chat_id, message_id, emoji });

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
