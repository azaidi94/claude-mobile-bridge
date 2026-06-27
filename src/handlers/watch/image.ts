/**
 * Image rendering for the watch path. Surfaces images Claude sees — browser
 * screenshots, image Reads, clipboard-pasted images (base64 blocks) and
 * @-referenced upload files (path) — into the Telegram topic as photos,
 * mirroring what the Claude mobile/desktop apps show inline but the terminal
 * can't.
 *
 * - Known image types within Telegram's size cap → sendPhoto (inline preview);
 *   oversized or non-image → document so it still arrives.
 * - Identical consecutive frames are skipped (state.lastImageHash).
 * - Caption: tool name for tool images, the user's accompanying text for
 *   pasted/uploaded images, else a generic label.
 */

import type { Api } from "grammy";
import { createHash } from "crypto";
import { statSync } from "fs";
import { basename, extname } from "path";
import { debug } from "../../logger";
import { getMessageBus } from "../../messaging";
import { escapeHtml } from "../../formatting";
import type { TailEvent } from "../../sessions/tailer";
import type { TailDisplayState } from "./state";

/** media_type → file extension for types Telegram renders as inline photos. */
const PHOTO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** File extensions Telegram renders as inline photos. */
const PHOTO_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

/** Telegram sendPhoto caps at 10 MB (and re-compresses); larger → document. */
const TG_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/** Telegram caps photo/document captions at 1024 visible chars. */
const CAPTION_MAX = 1000;

/** "mcp__claude-in-chrome__computer" → "claude-in-chrome: computer". */
function cleanToolName(name: string): string {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[1]}: ${m[2]}` : name;
}

type AttachmentSpec = {
  kind: "photo" | "document";
  filename: string;
  bytes?: Buffer;
  path?: string;
};

/** Resolve an in-memory base64 image into a send-ready attachment. */
function fromBase64(img: {
  mediaType?: string;
  dataBase64?: string;
}): AttachmentSpec | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(img.dataBase64 ?? "", "base64");
  } catch (err) {
    debug(`watch image: base64 decode failed: ${err}`);
    return null;
  }
  if (bytes.length === 0) return null;
  const ext = PHOTO_TYPES[(img.mediaType ?? "").toLowerCase()];
  const kind: "photo" | "document" =
    ext && bytes.length <= TG_PHOTO_MAX_BYTES ? "photo" : "document";
  return { kind, bytes, filename: `image.${ext ?? "bin"}` };
}

/** Resolve an @-referenced upload file into a send-ready attachment. */
function fromPath(path: string): AttachmentSpec {
  const ext = extname(path).slice(1).toLowerCase();
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // File may be gone; let the bus surface the read error on send.
  }
  const isPhoto =
    PHOTO_EXTS.has(ext) && (size === 0 || size <= TG_PHOTO_MAX_BYTES);
  return {
    kind: isPhoto ? "photo" : "document",
    path,
    filename: basename(path) || `image.${ext || "bin"}`,
  };
}

export function renderImage(
  _botApi: Api,
  state: TailDisplayState,
  event: TailEvent,
  threadId: number | undefined,
): void {
  const img = event.image;
  if (!img) return;

  // Dedup identical consecutive images: bytes by content hash, files by path.
  const dedupKey = img.dataBase64
    ? "b64:" + createHash("sha1").update(img.dataBase64).digest("hex")
    : img.path
      ? "path:" + img.path
      : null;
  if (!dedupKey) return;
  if (state.lastImageHash === dedupKey) {
    debug("watch image: skipped duplicate frame");
    return;
  }

  const spec = img.dataBase64
    ? fromBase64(img)
    : img.path
      ? fromPath(img.path)
      : null;
  if (!spec) return;
  state.lastImageHash = dedupKey;

  const toolName = state.toolUseRegistry?.get(event.toolUseId ?? "");
  // For pasted/uploaded images, event.content carries the user's accompanying
  // text (already stripped of paste annotations / @-refs by the tailer).
  const pastedText = event.toolUseId ? "" : (event.content ?? "").trim();
  let caption: string;
  if (toolName) {
    caption = `🖼 <b>${escapeHtml(cleanToolName(toolName))}</b>`;
  } else if (pastedText) {
    const text =
      pastedText.length > CAPTION_MAX
        ? pastedText.slice(0, CAPTION_MAX) + "…"
        : pastedText;
    caption = `🖥 <b>Terminal:</b> ${escapeHtml(text)}`;
  } else if (event.toolUseId) {
    caption = "🖼 Image";
  } else {
    caption = "🖼 Pasted image";
  }

  getMessageBus()
    .send({
      chatId: state.chatId,
      threadId,
      content: caption,
      format: "html",
      attachment: {
        kind: spec.kind,
        bytes: spec.bytes,
        path: spec.path,
        filename: spec.filename,
      },
      silent: true,
    })
    .catch((err) => debug(`watch image: send failed: ${err}`));
}
