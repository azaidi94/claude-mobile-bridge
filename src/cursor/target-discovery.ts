import type { CdpTarget } from "./cdp-client";

const COMPOSER_URL_HINTS = ["composer", "chat", "aichat", "sidebar"];

/**
 * Pick the best CDP target for Cursor's Composer webview from the list returned
 * by listCdpTargets(). Prefers page targets whose URL contains a composer/chat
 * hint; falls back to the first page target if none match.
 */
export function selectComposerTarget(targets: CdpTarget[]): CdpTarget | null {
  const pages = targets.filter((t) => t.type === "page");
  if (pages.length === 0) return null;

  const hint = pages.find((t) =>
    COMPOSER_URL_HINTS.some((h) => t.url.toLowerCase().includes(h)),
  );
  return hint ?? pages[0]!;
}
