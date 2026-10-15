const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The session id a `claude` command line pins, from `--session-id <id>` or
 * `--resume <id>`, each also spelled with `=` (the desktop app passes
 * `--resume=<id>`). A `--resume` with `--fork-session` starts a new id, so it
 * pins nothing.
 */
export function sessionIdFromClaudeArgs(args: string): string | undefined {
  const explicit = new RegExp(`(?:^|\\s)--session-id[=\\s]+(${UUID})`, "i");
  const sid = explicit.exec(args)?.[1];
  if (sid) return sid;
  if (/(?:^|\s)--fork-session(?:\s|=|$)/.test(args)) return undefined;
  return new RegExp(`(?:^|\\s)--resume[=\\s]+(${UUID})`, "i").exec(args)?.[1];
}
