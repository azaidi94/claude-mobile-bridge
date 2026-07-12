/**
 * Relay TCP client — connects to a channel-relay MCP server's TCP socket.
 * Newline-delimited JSON protocol.
 */

import { Socket } from "net";
import { RELAY_CONNECT_TIMEOUT_MS } from "../config";
import { debug, warn } from "../logger";
import { writeJsonLine } from "../utils/socket-writer";

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

export interface RelayAskRemoteOption {
  label: string;
  description?: string;
}

export interface RelayAskRemoteRequest {
  ask_id: string;
  chat_id: string;
  thread_id?: string;
  question: string;
  options: RelayAskRemoteOption[];
  allow_custom: boolean;
  /**
   * Mirrors the MCP-side timeout (default 30 min). The bot uses this to set
   * its own timer + 5s overshoot so the MCP's tool-result error wins the
   * race when the user never answers.
   */
  timeout_ms?: number;
}

type ReplyCallback = (msg: RelayReply) => void;
type EditCallback = (msg: RelayEditMessage) => void;
type ReactCallback = (msg: RelayReact) => void;
type AskRemoteCallback = (msg: RelayAskRemoteRequest) => void;
type DisconnectCallback = () => void;

interface ScopedCallback<T> {
  cb: T;
  chatId?: string; // when set, only fires for messages matching this chat_id
}

export class RelayClient {
  /**
   * Session metadata, set by getRelayClient after target resolution.
   * Used by listeners (e.g. relay-ask) to route bus emits keyed by name.
   */
  public sessionName?: string;
  public sessionDir?: string;
  private socket: Socket | null = null;
  private buffer = "";
  private _isConnected = false;
  private replyCallbacks: ScopedCallback<ReplyCallback>[] = [];
  private editCallbacks: ScopedCallback<EditCallback>[] = [];
  private reactCallbacks: ScopedCallback<ReactCallback>[] = [];
  private askRemoteCallbacks: AskRemoteCallback[] = [];
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
        debug("relay: connected to port", { port });
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
            warn("relay: parse error", err);
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
          warn("relay: socket error", err);
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
  }): boolean {
    return this.send({ type: "message", ...params });
  }

  /**
   * Send the user's answer back to the MCP for an in-flight ask_remote tool
   * call. Pass `error` (instead of `answer`) to surface a failure to Claude
   * — e.g. when the user cancels.
   */
  sendAskRemoteAnswer(params: {
    ask_id: string;
    answer?: string;
    error?: string;
  }): boolean {
    return this.send({ type: "ask_remote_answer", ...params });
  }

  onReply(cb: ReplyCallback, chatId?: string): void {
    this.replyCallbacks.push({ cb, chatId });
  }

  offReply(cb: ReplyCallback): void {
    this.replyCallbacks = this.replyCallbacks.filter((s) => s.cb !== cb);
  }

  onEditMessage(cb: EditCallback, chatId?: string): void {
    this.editCallbacks.push({ cb, chatId });
  }

  offEditMessage(cb: EditCallback): void {
    this.editCallbacks = this.editCallbacks.filter((s) => s.cb !== cb);
  }

  onReact(cb: ReactCallback, chatId?: string): void {
    this.reactCallbacks.push({ cb, chatId });
  }

  offReact(cb: ReactCallback): void {
    this.reactCallbacks = this.reactCallbacks.filter((s) => s.cb !== cb);
  }

  onAskRemoteRequest(cb: AskRemoteCallback): void {
    this.askRemoteCallbacks.push(cb);
  }

  offAskRemoteRequest(cb: AskRemoteCallback): void {
    this.askRemoteCallbacks = this.askRemoteCallbacks.filter((c) => c !== cb);
  }

  onDisconnect(cb: DisconnectCallback): void {
    this.disconnectCallbacks.push(cb);
  }

  offDisconnect(cb: DisconnectCallback): void {
    this.disconnectCallbacks = this.disconnectCallbacks.filter((c) => c !== cb);
  }

  private send(msg: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.destroyed || !this._isConnected) {
      debug("relay: cannot send, not connected", { type: msg.type });
      return false;
    }
    // Enqueue via the backpressure-aware writer so a slow MCP consumer cannot
    // grow Node's internal write queue unboundedly. The returned promise is
    // detached — failure surfaces via the warn() below; callers only need to
    // know the message was accepted into the in-order queue.
    writeJsonLine(this.socket, msg).catch((err) => {
      warn("relay: socket write failed", err, { type: msg.type });
    });
    return true;
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }): void {
    const msgChatId = String(msg.chat_id || "");

    switch (msg.type) {
      case "reply": {
        const text = String(msg.text || "");
        const files = (msg.files as string[]) ?? [];
        if (!text.trim() && files.length === 0) {
          debug("relay: dropping empty-text reply with no files", {
            chatId: msgChatId,
          });
          break;
        }
        const reply: RelayReply = {
          chat_id: msgChatId,
          text,
          files,
          send_as_pdf: Boolean(msg.send_as_pdf),
          pdf_filename: msg.pdf_filename ? String(msg.pdf_filename) : undefined,
        };
        for (const { cb, chatId } of this.replyCallbacks) {
          if (!chatId || chatId === msgChatId) cb(reply);
        }
        break;
      }

      case "edit_message": {
        const text = String(msg.text || "");
        if (!text.trim()) {
          debug("relay: dropping empty-text edit_message", {
            chatId: msgChatId,
            messageId: msg.message_id,
          });
          break;
        }
        const edit: RelayEditMessage = {
          chat_id: msgChatId,
          message_id: String(msg.message_id || ""),
          text,
        };
        for (const { cb, chatId } of this.editCallbacks) {
          if (!chatId || chatId === msgChatId) cb(edit);
        }
        break;
      }

      case "react": {
        const react: RelayReact = {
          chat_id: msgChatId,
          message_id: String(msg.message_id || ""),
          emoji: String(msg.emoji || ""),
        };
        for (const { cb, chatId } of this.reactCallbacks) {
          if (!chatId || chatId === msgChatId) cb(react);
        }
        break;
      }

      case "ask_remote_request": {
        const optionsRaw = (msg.options as unknown[]) ?? [];
        const options: RelayAskRemoteOption[] = [];
        for (const o of optionsRaw) {
          if (!o || typeof o !== "object") continue;
          const oo = o as { label?: unknown; description?: unknown };
          const label = String(oo.label ?? "").trim();
          if (!label) continue;
          options.push({
            label,
            description:
              oo.description !== undefined ? String(oo.description) : undefined,
          });
        }
        const askId = String(msg.ask_id || "");
        if (!askId || options.length < 1) {
          debug("relay: dropping invalid ask_remote_request", {
            ask_id: askId,
            optionCount: options.length,
          });
          break;
        }
        const timeoutMsRaw = msg.timeout_ms;
        const timeoutMs =
          typeof timeoutMsRaw === "number" && timeoutMsRaw > 0
            ? timeoutMsRaw
            : undefined;
        const req: RelayAskRemoteRequest = {
          ask_id: askId,
          chat_id: msgChatId,
          thread_id:
            msg.thread_id !== undefined ? String(msg.thread_id) : undefined,
          question: String(msg.question || ""),
          options,
          allow_custom: Boolean(msg.allow_custom),
          timeout_ms: timeoutMs,
        };
        for (const cb of this.askRemoteCallbacks) cb(req);
        break;
      }
    }
  }
}
