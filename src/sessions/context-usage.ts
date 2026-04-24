/**
 * Context-window usage helpers + per-session registry.
 *
 * Percentage matches the native Claude Code statusline:
 *   (input + cache_creation + cache_read) / CONTEXT_WINDOW.
 *
 * The per-watch notification bucket lives on WatchState
 * (src/handlers/watch.ts), not here.
 */

import type { TokenUsage } from "../types";
import { progressBar } from "../formatting";

export const CONTEXT_WINDOW = 1_000_000;

const registry = new Map<string, TokenUsage>();

export function recordUsage(sessionId: string, usage: TokenUsage): void {
  registry.set(sessionId, usage);
}

export function getLastUsage(sessionId: string): TokenUsage | undefined {
  return registry.get(sessionId);
}

export function forgetUsage(sessionId: string): void {
  registry.delete(sessionId);
}

export function _resetRegistryForTests(): void {
  registry.clear();
}

function totalContextTokens(u: TokenUsage): number {
  return (
    u.input_tokens +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  );
}

export function computeContextPct(u: TokenUsage): number {
  const pct = Math.round((totalContextTokens(u) * 100) / CONTEXT_WINDOW);
  return Math.min(100, pct);
}

export function contextBar(pct: number): string {
  return progressBar(pct, { filled: "●", empty: "○" });
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatContextLine(u: TokenUsage): string {
  const pct = computeContextPct(u);
  return `🧠 ${contextBar(pct)} ${pct}% (${formatTokens(totalContextTokens(u))}/${formatTokens(CONTEXT_WINDOW)})`;
}

export function checkThresholdCrossing(
  prevBucket: number,
  pct: number,
  step: number,
): { fire: boolean; bucket: number } {
  if (step <= 0) return { fire: false, bucket: prevBucket };
  const bucket = Math.floor(pct / step) * step;
  return { fire: bucket > prevBucket, bucket };
}
