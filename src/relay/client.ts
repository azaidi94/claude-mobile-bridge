/**
 * Relay TCP client — connects to a channel-relay MCP server's TCP socket.
 * Newline-delimited JSON protocol.
 */

import { Socket } from "net";
import { RELAY_CONNECT_TIMEOUT_MS } from "../config";
import { debug, warn } from "../logger";

export interface RelayReply {
  chat_id: string;
  text: string;
  files?: string[];
  send_as_pdf?: boolean;
  pdf_filename?: string;
}

export interface RelayEditMessage {
  chat_id: string;
  message_id: string;
  text: string;
}

export interface RelayReact {
  chat_id: string;
  message_id: string;
  emoji: string;
}

type ReplyCallback = (msg: RelayReply) => void;
type EditCallback = (msg: RelayEditMessage) => void;
type ReactCallback = (msg: RelayReact) => void;
type DisconnectCallback = () => void;

export class RelayClient {
  private socket: Socket | null = null;
  private buffer = "";
  private _isConnected = false;
  private replyCallbacks: ReplyCallback[] = [];
  private editCallbacks: EditCallback[] = [];
  private reactCallbacks: ReactCallback[] = [];
  private disconnectCallbacks: DisconnectCallback[] = [];

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Connect to the relay's TCP server.
   */
  connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new Socket();

      const timeout = setTimeout(() => {
        this.socket?.destroy();
        reject(new Error("relay connect timeout"));
      }, RELAY_CONNECT_TIMEOUT_MS);

      this.socket.connect(port, "127.0.0.1", () => {
        clearTimeout(timeout);
        this._isConnected = true;
        debug(`relay: connected to port ${port}`);
        resolve();
      });

      this.socket.on("data", (chunk) => {
        this.buffer += chunk.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.handleMessage(msg);
          } catch (err) {
            warn(`relay: parse error: ${err}`);
          }
        }
      });

      this.socket.on("close", () => {
        this._isConnected = false;
        debug("relay: disconnected");
        for (const cb of this.disconnectCallbacks) cb();
      });

      this.socket.on("error", (err) => {
        clearTimeout(timeout);
        this._isConnected = false;
        if (!this.socket?.connecting) {
          warn(`relay: socket error: ${err}`);
        }
        reject(err);
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this._isConnected = false;
    this.buffer = "";
  }

  sendMessage(params: {
    chat_id: string;
    user: string;
    text: string;
    image_path?: string;
  }): void {
    this.send({ type: "message", ...params });
  }

  onReply(cb: ReplyCallback): void {
    this.replyCallbacks.push(cb);
  }

  offReply(cb: ReplyCallback): void {
    this.replyCallbacks = this.replyCallbacks.filter((c) => c !== cb);
  }

  onEditMessage(cb: EditCallback): void {
    this.editCallbacks.push(cb);
  }

  onReact(cb: ReactCallback): void {
    this.reactCallbacks.push(cb);
  }

  onDisconnect(cb: DisconnectCallback): void {
    this.disconnectCallbacks.push(cb);
  }

  clearCallbacks(): void {
    this.replyCallbacks = [];
    this.editCallbacks = [];
    this.reactCallbacks = [];
    this.disconnectCallbacks = [];
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.socket || this.socket.destroyed || !this._isConnected) {
      warn("relay: cannot send, not connected");
      return;
    }
    this.socket.write(JSON.stringify(msg) + "\n");
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }): void {
    switch (msg.type) {
      case "reply":
        for (const cb of this.replyCallbacks) {
          cb({
            chat_id: String(msg.chat_id || ""),
            text: String(msg.text || ""),
            files: (msg.files as string[]) ?? [],
            send_as_pdf: Boolean(msg.send_as_pdf),
            pdf_filename: msg.pdf_filename
              ? String(msg.pdf_filename)
              : undefined,
          });
        }
        break;

      case "edit_message":
        for (const cb of this.editCallbacks) {
          cb({
            chat_id: String(msg.chat_id || ""),
            message_id: String(msg.message_id || ""),
            text: String(msg.text || ""),
          });
        }
        break;

      case "react":
        for (const cb of this.reactCallbacks) {
          cb({
            chat_id: String(msg.chat_id || ""),
            message_id: String(msg.message_id || ""),
            emoji: String(msg.emoji || ""),
          });
        }
        break;
    }
  }
}
