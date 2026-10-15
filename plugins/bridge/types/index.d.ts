/** What the band and `/bridge status` show; written by the poll and status timers. */
export type BridgeStatus = {
  /** The bot's control socket answered on the last check. */
  bot: "up" | "down" | "unknown";
  botPid: number | null;
  /**
   * polling: pulling from the relay · contended: another poller shares the
   * inbox · channels: CLI session, relay notifies · none: no relay found ·
   * error: relay found but not answering
   */
  relay: "polling" | "contended" | "channels" | "none" | "error" | "unknown";
  /** This session's Telegram topic, as the bot maps it. */
  topic: { name: string; link?: string } | null;
  /** When the last phone message was submitted here (epoch ms). */
  lastPhoneAt: number | null;
  /** When this copy of the mod started (epoch ms) — grace for startup warnings. */
  startedAt: number;
};

/** One relayed phone message, as the pane's feed lists it. */
export type FeedEntry = {
  /** When it was submitted here (epoch ms). */
  at: number;
  user: string | null;
  /** First line, cut to fit a row. */
  text: string;
};

/** The last `/bridge doctor` run, shown in the pane. */
export type DoctorRun = {
  at: number | null;
  /** formatDoctor's text; null before the first run. */
  text: string | null;
  isRunning: boolean;
};

declare module "claude-code" {
  interface PluginState {
    bridge: { status: BridgeStatus; feed: FeedEntry[]; doctor: DoctorRun };
  }
}
