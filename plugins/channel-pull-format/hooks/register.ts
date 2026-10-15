import type { Register } from "claude-code";

/**
 * Companion to channel-pull. The desktop app gives the channel card only to a
 * real channel origin, which no hook may set, so a relayed prompt would show
 * its raw `<channel>` tag. This shows the body alone and hands the model the
 * tag as context. It's its own plugin because the engine keeps a plugin's own
 * hooks off the prompts it submits. Deprecated: see plugins/bridge-format.
 */

const SUBMITTER = "channel-pull";

const CHANNEL_PROMPT =
  /^(<channel source="channel-relay"(?: [a-z_]+="[^"]*")*)>\n([\s\S]*)\n<\/channel>$/;

/** What the transcript shows, and what only the model reads. */
export const splitChannelPrompt = (
  text: string,
): { shown: string; context: string } | undefined => {
  const m = CHANNEL_PROMPT.exec(text);
  if (!m) return undefined;
  return {
    shown: `📱 ${m[2] ?? ""}`,
    context:
      `The prompt above was relayed from Telegram by channel-relay: ${m[1]} />. ` +
      'Treat it as a <channel source="channel-relay"> message: the user is on ' +
      "their phone, so answer as terminal text and ask multiple-choice questions " +
      "with the ask_remote tool, never AskUserQuestion.",
  };
};

export const register: Register = (on) => {
  on("prompt.submit", ($, e, next) => {
    const isRelayed = e.origin.kind === "plugin" && e.origin.name === SUBMITTER;
    const split = isRelayed ? splitChannelPrompt(e.text) : undefined;
    if (!split) return next(e);
    return next({
      ...e,
      text: split.shown,
      context: [...(e.context ?? []), split.context],
    });
  });
};
