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

// ── Inbound: bot → relay → Claude (channel notification) ──────────────

function handleBotMessage(msg: {
  type: string;
  chat_id?: string;
  user?: string;
  text?: string;
  image_path?: string;
}): void {
  if (msg.type === "message" && msg.text) {
    mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: msg.text,
        meta: {
          chat_id: msg.chat_id || "",
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
      'Messages from Telegram arrive as <channel source="channel-relay" chat_id="..." user="..." ts="...">.',
      "ONLY use the reply/edit_message/react tools when responding to <channel source=\"channel-relay\"> messages. Pass chat_id from the channel tag.",
      "When the user types directly in the terminal (no <channel> tag), respond normally in the terminal — do NOT use the reply tool.",
    ].join("\n"),
  },
);

// ── Tools: Claude → relay → bot (TCP response) ────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Reply to the Telegram user. Pass chat_id from the inbound channel message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string" },
          text: { type: "string" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Absolute file paths to attach.",
          },
        },
        required: ["chat_id", "text"],
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
      const chat_id = String(args.chat_id || "");
      const text = String(args.text || "");
      const files = (args.files as string[] | undefined) ?? [];

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
