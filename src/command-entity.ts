/**
 * Telegram only attaches a `bot_command` entity to `/word` when the span is
 * plain text. A command pasted from a code block arrives wrapped in a
 * `code`/`pre` entity instead, and grammY's `bot.command()` — which matches
 * on the entity, not the text — never fires, so the message falls through to
 * the free-text handler. This synthesises the missing entity so pasted
 * commands behave like typed ones.
 */

interface EntityLike {
  type: string;
  offset: number;
  length: number;
}

interface MessageLike {
  text?: string;
  entities?: EntityLike[];
}

// Same shape Telegram recognises: /name[@bot], ASCII word chars only.
const COMMAND_RE = /^\/[A-Za-z0-9_]{1,32}(?:@[A-Za-z0-9_]{1,32})?(?=\s|$)/;

/** Returns true when an entity was added. Mutates `msg` in place. */
export function ensureCommandEntity(msg: MessageLike): boolean {
  const text = msg.text;
  if (!text) return false;
  const m = COMMAND_RE.exec(text);
  if (!m) return false;
  const existing = msg.entities ?? [];
  if (existing.some((e) => e.type === "bot_command" && e.offset === 0)) {
    return false;
  }
  const length = m[0].length;
  // Drop any entity overlapping the command span — Telegram never overlaps
  // entities, and grammY reads the command off the entity alone.
  const kept = existing.filter((e) => e.offset >= length);
  msg.entities = [{ type: "bot_command", offset: 0, length }, ...kept];
  return true;
}
