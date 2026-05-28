/**
 * Parse-mode resolution and content chunking for the outbound MessageBus.
 *
 * Extracted from src/relay/display.ts so the bus and any other senders can
 * share one source of truth for "how do we hand this string to Telegram".
 */

import {
  convertMarkdownToHtml,
  looksLikeTelegramHtml,
  escapeHtml,
} from "../formatting";
import { TELEGRAM_SAFE_LIMIT } from "../config";

export type FormatHint = "auto" | "html" | "markdown" | "plain";

export type ResolvedParseMode = "HTML" | "MarkdownV2";

export interface ResolvedFormat {
  /** undefined → send without parse_mode (plain text). */
  parse_mode?: ResolvedParseMode;
  /** Content ready to hand to TG with the resolved parse_mode. */
  content: string;
}

/**
 * Resolve the parse_mode + final content for a given hint.
 *
 * - `auto` (default): if the content already looks like Telegram HTML, emit it
 *   as HTML (via the same convertMarkdownToHtml pipeline used by sendTextReply
 *   today — that path also handles markdown). Otherwise treat it as markdown
 *   and convert to HTML. We never emit Telegram's flaky `Markdown`/`MarkdownV2`
 *   from `auto`.
 * - `html`: caller swears the content is Telegram HTML. Run it through the
 *   markdown→HTML pipeline which also sanitises pre-authored HTML.
 * - `markdown`: caller wants TG's native MarkdownV2 (rare; escape hatch).
 *   We DO NOT escape here — caller is responsible. Returns parse_mode
 *   MarkdownV2 verbatim.
 * - `plain`: strip any incidental tag-like junk by escaping; no parse_mode.
 */
export function resolveParseMode(
  content: string,
  hint: FormatHint = "auto",
): ResolvedFormat {
  if (hint === "plain") {
    return { content };
  }
  if (hint === "markdown") {
    return { parse_mode: "MarkdownV2", content };
  }
  if (hint === "html") {
    return { parse_mode: "HTML", content: convertMarkdownToHtml(content) };
  }
  // auto
  if (looksLikeTelegramHtml(content)) {
    return { parse_mode: "HTML", content: convertMarkdownToHtml(content) };
  }
  // Treat as markdown; convertMarkdownToHtml produces TG-safe HTML.
  return { parse_mode: "HTML", content: convertMarkdownToHtml(content) };
}

/**
 * Get a plain-text fallback for a piece of content. Used when TG rejects the
 * resolved parse_mode (e.g. "can't parse entities") and we need to retry
 * without one.
 *
 * Strategy: if the caller authored HTML, strip tags via escapeHtml round-trip
 * is wrong (it'd literalise the tags). Instead, remove all tags and unescape
 * common entities. For markdown, just hand back the raw source.
 */
export function plainFallback(
  content: string,
  hint: FormatHint = "auto",
): string {
  if (hint === "plain") return content;
  // Strip tags then unescape the four entities convertMarkdownToHtml emits.
  const noTags = content.replace(/<[^>]+>/g, "");
  return noTags
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/**
 * Split content at paragraph/line boundaries so each chunk fits in `maxLen`.
 * Mirrors the splitMessage helper from src/relay/display.ts.
 *
 * If the content already fits, returns a single-element array.
 */
export function chunkContent(
  content: string,
  maxLen: number = TELEGRAM_SAFE_LIMIT,
): string[] {
  if (content.length <= maxLen) return [content];
  const chunks: string[] = [];
  let rest = content;
  while (rest.length > maxLen) {
    const para = rest.lastIndexOf("\n\n", maxLen);
    const line = rest.lastIndexOf("\n", maxLen);
    const cut = para > maxLen / 2 ? para : line > maxLen / 2 ? line : maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// Re-exported for tests and callers that don't want a separate import.
export { escapeHtml };
