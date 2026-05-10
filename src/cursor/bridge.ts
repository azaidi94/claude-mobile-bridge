// src/cursor/bridge.ts
import {
  buildObserverScript,
  buildInjectScript,
  parseSnapshotResult,
} from "./composer-io";
import { CursorSessionLog } from "./session-log";
import type { CdpClient } from "./cdp-client";
import type { SessionEventBus, SseEvent } from "../web/sse";
import { warn, info, debug } from "../logger";
import { updateSessionActivity } from "../sessions";

const HUMAN_BINDING = "cursorBridgeHumanMsg";
const AI_BINDING = "cursorBridgeAiMsg";

// Cursor renders an assistant turn as multiple sibling DOM bubbles
// (preamble, prose, table, code-block, ...). Each fires the binding
// independently. We collect every fragment between user inputs into
// a buffer, prefix-dedup within it, and flush as one combined emit
// when the next user input arrives or after AI_FLUSH_DELAY_MS quiet.
const AI_FLUSH_DELAY_MS = 6000;

// How long an injection's content stays in the recentlyInjected map.
// Long enough to span Cursor's render delay, short enough that the
// same text typed legitimately later still propagates.
const RECENT_INJECT_TTL_MS = 30_000;

/**
 * Normalize text so our injected-then-echoed-back-by-Cursor strings
 * match despite Lexical's auto-correct: hyphens become em-dashes,
 * straight quotes become curly, three dots become ellipsis. Compared
 * via this function, "foo - bar" and "foo — bar" are equivalent.
 */
function normalizeForCompare(text: string): string {
  return text
    .replace(/[‐-―]/g, "-") // ‐ ‑ ‒ – — ―  → -
    .replace(/[‘’]/g, "'") // ' ' → '
    .replace(/[“”]/g, '"') // " " → "
    .replace(/…/g, "...") // … → ...
    .replace(/\s+/g, " ") // collapse whitespace
    .trim()
    .toLowerCase();
}

/**
 * Strip markdown formatting so two fragments rendering the same
 * underlying content (one with ** _ ` # - markers, one without) compare
 * equal. Used to dedup the "Cursor sometimes renders the AI response
 * twice — once plain, once formatted" pattern.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1") // italic
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/^[-*]\s+/gm, "") // unordered list
    .replace(/^\d+\.\s+/gm, "") // ordered list
    .replace(/^>\s+/gm, "") // blockquote
    .replace(/\|/g, " ") // table cell separators
    .replace(/^[-:|\s]+$/gm, "") // table separator rows
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface CursorBridgeOptions {
  sessionName: string;
  sessionDir: string;
  cdpClient: CdpClient;
  bus: SessionEventBus;
  /** Override the AI flush window. Tests use a very small value. */
  aiFlushDelayMs?: number;
}

/**
 * Cap on `seenMessages` — every distinct human message in the session adds
 * an entry, and entries are never removed by themselves. Without a bound, a
 * long-running session with thousands of messages would grow this to MBs.
 * 2000 mirrors the JSONL tail truncation. Set iterates in insertion order, so
 * eviction is FIFO — the oldest message becomes re-eligible for the dedup
 * check, which is acceptable: if a 2000-message-old line repeats verbatim
 * we'll re-emit it, far better than unbounded growth.
 */
const SEEN_MESSAGES_MAX = 2000;

export class CursorBridge {
  private unsubBus: (() => void) | null = null;
  private unsubNotification: (() => void) | null = null;
  private seenMessages = new Set<string>();
  // Text we injected from a non-cursor source, normalized → time
  // injected. TTL-based so a duplicate HUMAN_BINDING fire (Cursor
  // can render the same bubble in multiple panels) is suppressed
  // every time, but the same content typed legitimately later still
  // gets through. Pruned lazily on each access.
  private recentlyInjected = new Map<string, number>();
  // Multi-fragment AI buffer. Cursor produces multiple bubbles per
  // assistant turn — collect them all, prefix-dedup, concat on flush.
  private aiBuffer: string[] = [];
  private aiTimer: Timer | null = null;
  private log: CursorSessionLog | null = null;

  constructor(private opts: CursorBridgeOptions) {}

  async start(): Promise<void> {
    const { sessionName, sessionDir, cdpClient, bus } = this.opts;

    // Note: session registration (addCursorSession) is the caller's
    // responsibility — see cursor/index.ts:attachBridge. Doing it here
    // would orphan the registry entry if any of the awaits below
    // rejected, leaving the session visible in the API with no bridge
    // listening.
    this.log = new CursorSessionLog(sessionName, sessionDir);

    // Enable CDP Runtime domain so notifications are delivered
    await cdpClient.sendCommand("Runtime.enable");

    // Register binding names so JS can call window[name](text)
    await cdpClient.sendCommand("Runtime.addBinding", { name: HUMAN_BINDING });
    await cdpClient.sendCommand("Runtime.addBinding", { name: AI_BINDING });

    // Inject the MutationObserver; returns initial snapshot of existing user messages
    const snapshotResult = await cdpClient.sendCommand("Runtime.evaluate", {
      expression: buildObserverScript({
        human: HUMAN_BINDING,
        ai: AI_BINDING,
      }),
      returnByValue: true,
      awaitPromise: false,
    });
    for (const msg of parseSnapshotResult(snapshotResult)) {
      this.addSeen(msg);
    }

    // Subscribe to Runtime.bindingCalled — new messages from Cursor
    this.unsubNotification = cdpClient.onNotification(
      "Runtime.bindingCalled",
      (params) => {
        const text = String(params.payload ?? "").trim();
        if (!text) return;

        if (params.name === HUMAN_BINDING) {
          // Drop our own injection echo. Compare via normalized form
          // (lower-cased, dashes/quotes/whitespace folded) so Cursor's
          // Lexical auto-correct doesn't cause a false miss.
          const norm = normalizeForCompare(text);
          this.pruneRecentlyInjected();
          if (this.recentlyInjected.has(norm)) {
            debug(
              `cursor-bridge: suppressed echo (${text.length} chars): ${text.slice(0, 60)}`,
            );
            // Keep the entry in the map until it ages out — Cursor can
            // re-render the same bubble in multiple panels and each
            // re-render fires another HUMAN_BINDING for the same text.
            return;
          }
          if (this.seenMessages.has(text)) return;
          this.addSeen(text);
          // A new human message means the prior AI turn is finished —
          // flush any pending AI buffer now so order is preserved.
          this.flushAiBuffer();
          debug(`cursor-bridge: human msg: ${text.slice(0, 80)}`);
          // Heartbeat the registry so a long-lived but actively-used
          // Cursor window doesn't get pruned by refresh()'s 24h MAX_AGE
          // check (bug_007). lastActivity was only set at attach time.
          updateSessionActivity(sessionName);
          // Native cursor input — recorded with source: cursor.
          void this.log?.appendUser(text, "cursor");
          bus.emit(sessionName, {
            type: "user_message",
            source: "cursor",
            content: text,
          });
        } else if (params.name === AI_BINDING) {
          // AI activity is also user-driven traffic for prune purposes.
          updateSessionActivity(sessionName);
          this.bufferAiFragment(text);
        }
      },
    );

    // Subscribe to bus — inject non-cursor messages into Composer
    this.unsubBus = bus.subscribe(sessionName, (evt: SseEvent) => {
      if (evt.type !== "user_message") return;
      if (evt.source === "cursor") return; // prevent echo
      // A new user input means any in-flight AI buffer is done —
      // flush before injecting so order stays consistent across
      // surfaces (the prior AI reply lands before this new question).
      this.flushAiBuffer();
      // Log the user message at the source — Cursor's observer will
      // fire HUMAN_BINDING for the same text but we drop that echo
      // above to avoid double-logging and double cross-posting.
      void this.log?.appendUser(
        evt.content,
        // evt.source is one of telegram | web | terminal | cursor; we
        // already filtered out cursor above. Default narrowing.
        (evt.source ?? "web") as Parameters<
          NonNullable<typeof this.log>["appendUser"]
        >[1],
      );
      this.recentlyInjected.set(normalizeForCompare(evt.content), Date.now());
      this.pruneRecentlyInjected();
      void cdpClient
        .sendCommand("Runtime.evaluate", {
          expression: buildInjectScript(evt.content),
          returnByValue: true,
        })
        .then((result) => {
          // CDP doesn't reject on JS exceptions in evaluated code — it
          // returns a result with exceptionDetails. Surface those so a
          // broken inject script fails loudly instead of silently.
          const detail = (result as { exceptionDetails?: unknown })
            .exceptionDetails;
          if (detail) {
            const desc =
              (detail as { exception?: { description?: string } }).exception
                ?.description ?? JSON.stringify(detail);
            warn(`cursor-bridge: inject threw in page: ${desc}`);
          }
        })
        .catch((e: unknown) => {
          warn(
            `cursor-bridge: inject transport failed: ${(e as Error).message}`,
          );
        });
    });

    info(`cursor-bridge: started for session "${sessionName}"`);
  }

  stop(): void {
    this.unsubNotification?.();
    this.unsubNotification = null;
    this.unsubBus?.();
    this.unsubBus = null;
    this.flushAiBuffer();
    this.opts.cdpClient.close();
    info(`cursor-bridge: stopped for session "${this.opts.sessionName}"`);
  }

  /**
   * Add an observed AI fragment to the buffer with prefix-dedup.
   * Comparison runs on a markdown-stripped lowercased form so a
   * plain-text bubble and its formatted twin (Cursor sometimes
   * renders both for the same response) collapse to one slot —
   * the formatted version wins because it's almost always longer.
   *
   *   - same content (modulo markdown) → drop new
   *   - new is fuller version of existing → replace
   *   - completely different → append slot
   * Resets the inactivity timer on every accepted addition.
   */
  private bufferAiFragment(text: string): void {
    if (!text.trim()) return; // truly empty
    const normNew = stripMarkdown(text);

    // Pure code-block / non-prose bubbles strip to "". Skip the
    // markdown-stripped dedup loop entirely — empty-stripped strings
    // would falsely match anything via `s.startsWith("")`. Append
    // unconditionally so a fenced-code-only AI reply still flushes.
    if (!normNew) {
      this.aiBuffer.push(text);
      this.scheduleAiFlush();
      return;
    }

    let merged = false;
    for (let i = 0; i < this.aiBuffer.length; i++) {
      const cur = this.aiBuffer[i]!;
      const normCur = stripMarkdown(cur);
      // Skip slots whose stripped form is empty — they were appended
      // via the code-block path above and have no comparable text.
      if (!normCur) continue;
      if (normCur === normNew) {
        // Same content (modulo markdown). Keep the longer raw version
        // — that's almost always the markdown-formatted one which we
        // want to surface over the plain twin.
        if (text.length > cur.length) {
          this.aiBuffer[i] = text;
          merged = true;
          break;
        }
        return; // existing wins
      }
      if (normCur.startsWith(normNew)) return; // existing is fuller
      if (normNew.startsWith(normCur)) {
        this.aiBuffer[i] = text; // new is fuller — upgrade
        merged = true;
        break;
      }
    }
    if (!merged) this.aiBuffer.push(text);
    this.scheduleAiFlush();
  }

  private scheduleAiFlush(): void {
    if (this.aiTimer) clearTimeout(this.aiTimer);
    const delay = this.opts.aiFlushDelayMs ?? AI_FLUSH_DELAY_MS;
    this.aiTimer = setTimeout(() => this.flushAiBuffer(), delay);
  }

  private flushAiBuffer(): void {
    if (this.aiTimer) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
    if (this.aiBuffer.length === 0) return;
    const combined = this.aiBuffer.join("\n\n");
    this.aiBuffer = [];
    debug(
      `cursor-bridge: ai msg (${combined.length} chars): ${combined.slice(0, 80)}`,
    );
    void this.log?.appendAssistant(combined, "cursor");
    this.opts.bus.emit(this.opts.sessionName, {
      type: "text",
      source: "cursor",
      content: combined,
    });
  }

  private pruneRecentlyInjected(): void {
    const cutoff = Date.now() - RECENT_INJECT_TTL_MS;
    for (const [k, t] of this.recentlyInjected) {
      if (t < cutoff) this.recentlyInjected.delete(k);
    }
  }

  /**
   * FIFO-bounded insert into seenMessages. Set iterates in insertion order,
   * so once we hit the cap the oldest entry is dropped before the new one
   * is added — keeps memory bounded over a long session.
   */
  private addSeen(text: string): void {
    if (this.seenMessages.size >= SEEN_MESSAGES_MAX) {
      const oldest = this.seenMessages.values().next().value;
      if (oldest !== undefined) this.seenMessages.delete(oldest);
    }
    this.seenMessages.add(text);
  }
}
