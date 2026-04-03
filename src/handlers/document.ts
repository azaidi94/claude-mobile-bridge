/**
 * Document handler for Claude Telegram Bot.
 *
 * Supports PDFs and text files with media group buffering.
 * PDF extraction uses pdftotext CLI (install via: brew install poppler)
 */

import type { Context } from "grammy";
import { session } from "../session";
import { ALLOWED_USERS, TEMP_DIR } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { auditLog, auditLogRateLimit } from "../utils";
import { createMediaGroupBuffer } from "./media-group";
import { sendViaRelay } from "./relay-bridge";
import { isRelayAvailable } from "../relay";
import { getActiveSession } from "../sessions";
import {
  createOpId,
  elapsedMs,
  error as logError,
  info,
  warn,
} from "../logger";

// Supported text file extensions
const TEXT_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".env",
  ".log",
  ".cfg",
  ".ini",
  ".toml",
];

// Supported archive extensions
const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tar.gz", ".tgz"];

// Max file size (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Max content from archive (50K chars total)
const MAX_ARCHIVE_CONTENT = 50000;

// Create document-specific media group buffer
const documentBuffer = createMediaGroupBuffer({
  emoji: "📄",
  itemLabel: "document",
  itemLabelPlural: "documents",
});

/**
 * Download a document and return the local path.
 */
async function downloadDocument(ctx: Context): Promise<string> {
  const doc = ctx.message?.document;
  if (!doc) {
    throw new Error("No document in message");
  }

  const file = await ctx.getFile();
  const fileName = doc.file_name || `doc_${Date.now()}`;

  // Sanitize filename
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const docPath = `${TEMP_DIR}/${safeName}`;

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`,
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(docPath, buffer);

  return docPath;
}

/**
 * Extract text from a document.
 */
async function extractText(
  filePath: string,
  mimeType?: string,
): Promise<string> {
  const fileName = filePath.split("/").pop() || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();

  // PDF extraction using pdftotext CLI (install: brew install poppler)
  if (mimeType === "application/pdf" || extension === ".pdf") {
    try {
      const result = await Bun.$`pdftotext -layout ${filePath} -`.quiet();
      return result.text();
    } catch (error) {
      logError("document: pdf parsing failed", error, { filePath });
      return "[PDF parsing failed - ensure pdftotext is installed: brew install poppler]";
    }
  }

  // Text files
  if (TEXT_EXTENSIONS.includes(extension) || mimeType?.startsWith("text/")) {
    const text = await Bun.file(filePath).text();
    // Limit to 100K chars
    return text.slice(0, 100000);
  }

  throw new Error(`Unsupported file type: ${extension || mimeType}`);
}

/**
 * Check if a file extension is an archive.
 */
function isArchive(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Get archive extension from filename.
 */
function getArchiveExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  if (lower.endsWith(".tgz")) return ".tgz";
  if (lower.endsWith(".tar")) return ".tar";
  if (lower.endsWith(".zip")) return ".zip";
  return "";
}

/**
 * Extract an archive to a temp directory.
 */
async function extractArchive(
  archivePath: string,
  fileName: string,
): Promise<string> {
  const ext = getArchiveExtension(fileName);
  const extractDir = `${TEMP_DIR}/archive_${Date.now()}`;
  await Bun.$`mkdir -p ${extractDir}`;

  if (ext === ".zip") {
    await Bun.$`unzip -q -o ${archivePath} -d ${extractDir}`.quiet();
  } else if (ext === ".tar" || ext === ".tar.gz" || ext === ".tgz") {
    await Bun.$`tar -xf ${archivePath} -C ${extractDir}`.quiet();
  } else {
    throw new Error(`Unknown archive type: ${ext}`);
  }

  return extractDir;
}

/**
 * Build a file tree from a directory.
 */
async function buildFileTree(dir: string): Promise<string[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: dir, dot: false }),
  );
  entries.sort();
  return entries.slice(0, 100); // Limit to 100 files
}

/**
 * Extract text content from archive files.
 */
async function extractArchiveContent(extractDir: string): Promise<{
  tree: string[];
  contents: Array<{ name: string; content: string }>;
}> {
  const tree = await buildFileTree(extractDir);
  const contents: Array<{ name: string; content: string }> = [];
  let totalSize = 0;

  for (const relativePath of tree) {
    const fullPath = `${extractDir}/${relativePath}`;
    const stat = await Bun.file(fullPath).exists();
    if (!stat) continue;

    // Check if it's a directory
    const fileInfo = Bun.file(fullPath);
    const size = fileInfo.size;
    if (size === 0) continue;

    const ext = "." + (relativePath.split(".").pop() || "").toLowerCase();
    if (!TEXT_EXTENSIONS.includes(ext)) continue;

    // Skip large files
    if (size > 100000) continue;

    try {
      const text = await fileInfo.text();
      const truncated = text.slice(0, 10000); // 10K per file max
      if (totalSize + truncated.length > MAX_ARCHIVE_CONTENT) break;
      contents.push({ name: relativePath, content: truncated });
      totalSize += truncated.length;
    } catch {
      // Skip binary or unreadable files
    }
  }

  return { tree, contents };
}

/**
 * Process an archive file via relay.
 *
 * Extracts the archive, builds a text summary (file tree + readable contents),
 * and sends it through the relay as a message.
 */
async function processArchive(
  ctx: Context,
  archivePath: string,
  fileName: string,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number,
  opId: string,
): Promise<void> {
  const stopProcessing = session.startProcessing();
  const requestStartedAt = Date.now();

  const statusMsg = await ctx.reply(`📦 Extracting <b>${fileName}</b>...`, {
    parse_mode: "HTML",
  });

  try {
    info("document: extracting archive", {
      opId,
      fileName,
      archivePath,
      chatId,
      userId,
    });
    const extractStartedAt = Date.now();
    const extractDir = await extractArchive(archivePath, fileName);
    const { tree, contents } = await extractArchiveContent(extractDir);
    info("document: archive extracted", {
      opId,
      fileName,
      extractDir,
      fileCount: tree.length,
      readableCount: contents.length,
      chatId,
      userId,
      durationMs: elapsedMs(extractStartedAt),
    });

    // Cleanup extracted files
    await Bun.$`rm -rf ${extractDir}`.quiet();

    // Delete status message
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore
    }

    // Build prompt
    const treeStr = tree.length > 0 ? tree.join("\n") : "(empty)";
    const contentsStr =
      contents.length > 0
        ? contents.map((c) => `--- ${c.name} ---\n${c.content}`).join("\n\n")
        : "(no readable text files)";

    const prompt = caption
      ? `Archive: ${fileName}\n\nFile tree (${tree.length} files):\n${treeStr}\n\nExtracted contents:\n${contentsStr}\n\n---\n\n${caption}`
      : `Please analyze this archive (${fileName}):\n\nFile tree (${tree.length} files):\n${treeStr}\n\nExtracted contents:\n${contentsStr}`;

    const relayResult = await sendViaRelay(
      ctx,
      prompt,
      username,
      chatId,
      undefined,
      opId,
    );
    if (relayResult === "delivered") {
      await auditLog(
        userId,
        username,
        "ARCHIVE",
        `[${fileName}] ${caption || ""}`,
        "(via relay)",
      );
      info("request: completed", {
        opId,
        requestKind: "archive",
        chatId,
        userId,
        durationMs: elapsedMs(requestStartedAt),
        path: "relay",
        fileName,
      });
      return;
    }

    warn("request: relay " + relayResult, {
      opId,
      requestKind: "archive",
      chatId,
      userId,
      durationMs: elapsedMs(requestStartedAt),
    });
    if (relayResult === "failed") {
      await ctx.reply(
        "⚠️ Message was sent but the session stopped responding.\n" +
          "It may still be processing. Check /status or try again.",
      );
    } else {
      await ctx.reply(
        "❌ No desktop session found.\n\n" +
          "Use /new to spawn one, or /list to find existing sessions.",
      );
    }
  } catch (error) {
    logError("document: archive processing failed", error, {
      opId,
      fileName,
      archivePath,
      chatId,
      userId,
      username,
      durationMs: elapsedMs(requestStartedAt),
    });
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore
    }
    await ctx.reply(
      `❌ Failed to process archive: ${String(error).slice(0, 100)}`,
    );
  } finally {
    stopProcessing();
  }
}

/**
 * Process documents via relay.
 */
async function processDocuments(
  ctx: Context,
  documents: Array<{ path: string; name: string; content: string }>,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number,
  opId: string,
): Promise<void> {
  const stopProcessing = session.startProcessing();
  const requestStartedAt = Date.now();

  // Build prompt
  let prompt: string;
  if (documents.length === 1) {
    const doc = documents[0]!;
    prompt = caption
      ? `Document: ${doc.name}\n\nContent:\n${doc.content}\n\n---\n\n${caption}`
      : `Please analyze this document (${doc.name}):\n\n${doc.content}`;
  } else {
    const docList = documents
      .map((d, i) => `--- Document ${i + 1}: ${d.name} ---\n${d.content}`)
      .join("\n\n");
    prompt = caption
      ? `${documents.length} Documents:\n\n${docList}\n\n---\n\n${caption}`
      : `Please analyze these ${documents.length} documents:\n\n${docList}`;
  }

  try {
    const relayResult = await sendViaRelay(
      ctx,
      prompt,
      username,
      chatId,
      undefined,
      opId,
    );
    if (relayResult === "delivered") {
      await auditLog(
        userId,
        username,
        "DOCUMENT",
        `[${documents.length} docs] ${caption || ""}`,
        "(via relay)",
      );
      info("request: completed", {
        opId,
        requestKind: documents.length === 1 ? "document" : "document_batch",
        chatId,
        userId,
        durationMs: elapsedMs(requestStartedAt),
        path: "relay",
        documentCount: documents.length,
      });
      return;
    }

    warn("request: relay " + relayResult, {
      opId,
      requestKind: "document",
      chatId,
      userId,
      durationMs: elapsedMs(requestStartedAt),
    });
    if (relayResult === "failed") {
      await ctx.reply(
        "⚠️ Message was sent but the session stopped responding.\n" +
          "It may still be processing. Check /status or try again.",
      );
    } else {
      await ctx.reply(
        "❌ No desktop session found.\n\n" +
          "Use /new to spawn one, or /list to find existing sessions.",
      );
    }
  } finally {
    stopProcessing();
  }
}

/**
 * Process document paths by extracting text and calling processDocuments.
 */
async function processDocumentPaths(
  ctx: Context,
  paths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number,
  opId: string,
): Promise<void> {
  // Extract text from all documents
  const documents: Array<{ path: string; name: string; content: string }> = [];
  const extractStartedAt = Date.now();

  for (const path of paths) {
    try {
      const name = path.split("/").pop() || "document";
      const content = await extractText(path);
      documents.push({ path, name, content });
    } catch (error) {
      logError("document: extract failed", error, {
        opId,
        path,
        chatId,
        userId,
      });
    }
  }

  info("document: extracted text", {
    opId,
    chatId,
    userId,
    durationMs: elapsedMs(extractStartedAt),
    requestedCount: paths.length,
    extractedCount: documents.length,
  });

  if (documents.length === 0) {
    await ctx.reply("❌ Failed to extract any documents.");
    return;
  }

  await processDocuments(
    ctx,
    documents,
    caption,
    userId,
    username,
    chatId,
    opId,
  );
}

/**
 * Handle incoming document messages.
 */
export async function handleDocument(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const doc = ctx.message?.document;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId || !doc) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check file size
  if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
    await ctx.reply("❌ File too large. Maximum size is 10MB.");
    return;
  }

  // 3. Check file type
  const fileName = doc.file_name || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();
  const isPdf = doc.mime_type === "application/pdf" || extension === ".pdf";
  const isText =
    TEXT_EXTENSIONS.includes(extension) || doc.mime_type?.startsWith("text/");
  const isArchiveFile = isArchive(fileName);
  const opId = createOpId(
    isArchiveFile ? "archive" : mediaGroupId ? "document_batch" : "document",
  );
  info("request: started", {
    opId,
    requestKind: isArchiveFile
      ? "archive"
      : mediaGroupId
        ? "document_batch"
        : "document",
    chatId,
    userId,
    username,
    fileName,
  });

  if (!isPdf && !isText && !isArchiveFile) {
    await ctx.reply(
      `❌ Unsupported file type: ${extension || doc.mime_type}\n\n` +
        `Supported: PDF, archives (${ARCHIVE_EXTENSIONS.join(
          ", ",
        )}), ${TEXT_EXTENSIONS.join(", ")}`,
    );
    return;
  }

  // 4. Relay preflight — avoid download/extraction if no session exists
  const active = getActiveSession();
  const relayUp = await isRelayAvailable({
    sessionId: active?.info.id,
    sessionDir: session.workingDir || active?.info.dir,
    claudePid: active?.info.pid,
  });
  if (!relayUp) {
    await ctx.reply(
      "❌ No desktop session found.\n\n" +
        "Use /new to spawn one, or /list to find existing sessions.",
    );
    return;
  }

  // 5. Download document
  let docPath: string;
  try {
    docPath = await downloadDocument(ctx);
  } catch (error) {
    logError("document: download failed", error, {
      opId,
      fileName,
      chatId,
      userId,
      username,
    });
    await ctx.reply("❌ Failed to download document.");
    return;
  }

  // 5. Archive files - process separately (no media group support)
  if (isArchiveFile) {
    info("document: received archive", {
      fileName,
      username,
      chatId,
      userId,
    });
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`,
      );
      return;
    }

    await processArchive(
      ctx,
      docPath,
      fileName,
      ctx.message?.caption,
      userId,
      username,
      chatId,
      opId,
    );
    return;
  }

  // 6. Single document - process immediately
  if (!mediaGroupId) {
    info("document: received", {
      fileName,
      username,
      chatId,
      userId,
    });
    // Rate limit
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`,
      );
      return;
    }

    try {
      const content = await extractText(docPath, doc.mime_type);
      await processDocuments(
        ctx,
        [{ path: docPath, name: fileName, content }],
        ctx.message?.caption,
        userId,
        username,
        chatId,
        opId,
      );
    } catch (error) {
      logError("document: single-file processing failed", error, {
        opId,
        fileName,
        docPath,
        chatId,
        userId,
      });
      await ctx.reply(
        `❌ Failed to process document: ${String(error).slice(0, 100)}`,
      );
    }
    return;
  }

  // 7. Media group - buffer with timeout
  await documentBuffer.addToGroup(
    mediaGroupId,
    docPath,
    ctx,
    userId,
    username,
    (groupCtx, items, groupCaption, groupUserId, groupUsername, groupChatId) =>
      processDocumentPaths(
        groupCtx,
        items,
        groupCaption,
        groupUserId,
        groupUsername,
        groupChatId,
        opId,
      ),
  );
}
