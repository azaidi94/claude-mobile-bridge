/**
 * Token registry for inline-keyboard menus.
 *
 * Telegram caps `callback_data` at 64 bytes, so buttons never carry paths or
 * session ids. Each button gets an 8-char token that resolves here to the
 * real payload. Entries expire (TTL) and are chat-scoped so a token tapped in
 * another chat, or after a bot restart, does nothing.
 */

export interface MenuEntry {
  /** Dispatch key — which handler owns this payload (e.g. "folder.enter"). */
  kind: string;
  payload: unknown;
  /** Chat the menu was rendered in; taps from elsewhere are refused. */
  chatId: number;
  createdAt: number;
}

export const MENU_TOKEN_TTL_MS = 30 * 60 * 1000;
const SWEEP_THRESHOLD = 500;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

const entries = new Map<string, MenuEntry>();

function randomToken(): string {
  let t = "";
  for (let i = 0; i < 8; i++) {
    t += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return t;
}

function sweep(now: number): void {
  for (const [token, e] of entries) {
    if (now - e.createdAt > MENU_TOKEN_TTL_MS) entries.delete(token);
  }
}

export function putToken(
  entry: Omit<MenuEntry, "createdAt">,
  now: number = Date.now(),
): string {
  if (entries.size > SWEEP_THRESHOLD) sweep(now);
  let token = randomToken();
  while (entries.has(token)) token = randomToken();
  entries.set(token, { ...entry, createdAt: now });
  return token;
}

/** Undefined when unknown or expired (expired entries are dropped). */
export function getToken(
  token: string,
  now: number = Date.now(),
): MenuEntry | undefined {
  const e = entries.get(token);
  if (!e) return undefined;
  if (now - e.createdAt > MENU_TOKEN_TTL_MS) {
    entries.delete(token);
    return undefined;
  }
  return e;
}

export function _resetMenuRegistryForTests(): void {
  entries.clear();
}
