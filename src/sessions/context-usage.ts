/**
 * Context-window usage helpers + per-session registry.
 *
 * Assistant turns carry a `usage` block with input/output/cache tokens.
 * `current = input + cache_creation + cache_read` over `CONTEXT_WINDOW`
 * gives the same percentage the native Claude Code statusline displays.
 *
 * The registry stores only `lastUsage` per session — the per-watch
 * notification bucket lives on WatchState (src/handlers/watch.ts).
 */

import type { TokenUsage } from "../types";

export const CONTEXT_WINDOW = 1_000_000;

export interface ContextState {
  lastUsage: TokenUsage;
}

const registry = new Map<string, ContextState>();

export function recordUsage(sessionId: string, usage: TokenUsage): void {
  registry.set(sessionId, { lastUsage: usage });
}

export function getContextState(sessionId: string): ContextState | undefined {
  return registry.get(sessionId);
}

export function _resetRegistryForTests(): void {
  registry.clear();
}

export function computeContextPct(u: TokenUsage): number {
  const used =
    (u.input_tokens || 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  const pct = Math.round((used * 100) / CONTEXT_WINDOW);
  return Math.min(100, pct);
}

export function contextBar(pct: number): string {
  const filled = Math.min(10, Math.max(0, Math.floor(pct / 10)));
  return "●".repeat(filled) + "○".repeat(10 - filled);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatContextLine(u: TokenUsage): string {
  const pct = computeContextPct(u);
  const bar = contextBar(pct);
  const used =
    (u.input_tokens || 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  return `🧠 ${bar} ${pct}% (${formatTokens(used)}/${formatTokens(CONTEXT_WINDOW)})`;
}

/**
 * Returns the current bucket for `pct` at `step` granularity, and whether
 * it has grown past `prevBucket` (i.e. a new threshold was crossed).
 *
 * `step === 0` disables notifications. Caller is responsible for resetting
 * `prevBucket` to 0 when `pct` drops (e.g. after /compact).
 */
export function checkThresholdCrossing(
  prevBucket: number,
  pct: number,
  step: number,
): { fire: boolean; bucket: number } {
  if (step <= 0) return { fire: false, bucket: prevBucket };
  const bucket = Math.floor(pct / step) * step;
  return { fire: bucket > prevBucket, bucket };
}
