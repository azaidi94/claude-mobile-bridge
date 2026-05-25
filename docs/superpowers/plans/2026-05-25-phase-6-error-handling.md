# Phase 6 — Error handling discipline

**Goal:** Categorise every existing try/catch (214 of them); replace silent catches with `safeAsync()` helper that always logs; ban bare `catch {}` going forward.

**Estimated effort:** 1 day.

**Branch:** `refactor/phase-6-error-handling`

**Dependencies:** None strictly; cleanest after Phase 3 (god files split) so the audit is per-file-shaped.

## Why

A grep across the codebase finds:

- **214 try/catch blocks** in production code
- **17 explicitly empty catches** (`catch {}` or `catch (_e) {}` or `catch { /* ignore */ }`)
- **Many more `catch (err) { warn(...); }` patterns** that swallow the error after logging it

This is the failure mode that hides the bugs the user reports via screenshots — because nothing surfaces in logs that would let us pre-empt them.

The recent example: the relay's `runDiscovery` loop had `catch { return; }` which silently killed the retry chain on a transient port-file read race. We patched it specifically; the _category_ of bug still exists in 213 other places.

## Target

```ts
// src/utils/safe-async.ts (new)
export async function safeAsync<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: {
    onError?: "log" | "throw" | "log-and-throw";
    severity?: "debug" | "info" | "warn" | "error";
  },
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const severity = opts?.severity ?? "warn";
    logger[severity](`${label} failed`, {
      err_name: (err as Error)?.name,
      err_msg: (err as Error)?.message,
      err_stack: (err as Error)?.stack?.split("\n").slice(0, 5).join("\n"),
    });
    if (opts?.onError === "throw" || opts?.onError === "log-and-throw") {
      throw err;
    }
    return undefined;
  }
}
```

Used as:

```ts
// Before
try {
  await api.deleteForumTopic(chatId, topicId);
} catch {
  // ignore
}

// After
await safeAsync("topic.delete", () => api.deleteForumTopic(chatId, topicId));
```

The label gives every swallowed error a unique grep handle in logs. No more invisible failures.

## Audit categorisation

Every existing try/catch falls into one of three buckets:

**(a) Genuinely OK to silently continue.** Examples: cleaning up best-effort temp files in a finally, parsing optional JSON config, retrying with backoff in a loop. Keep these — but annotate with `// silently ok: <why>` comment so future readers don't think it's a bug.

**(b) Should log and continue.** Most current "ignore" catches actually want this. Convert to `safeAsync(label, fn)`.

**(c) Should propagate.** Errors that the caller has a meaningful response for. Convert to plain throws + caller-side handling.

## Scope

### Files that change

This phase touches **every file with a try/catch** — likely 40+ files. The change per site is mechanical:

- `catch {}` → `safeAsync()`
- `catch (err) { warn(...); }` → `safeAsync()` (logging is built in)
- Critical paths that should propagate → remove the catch, let it throw

### New files

| File                                                         | Purpose                      |
| ------------------------------------------------------------ | ---------------------------- |
| `src/utils/safe-async.ts`                                    | The helper                   |
| `src/__tests__/safe-async.test.ts`                           | Helper coverage              |
| `docs/superpowers/notes/2026-05-XX-error-handling-policy.md` | The convention going forward |

## Stepwise approach

1. **Ship `safeAsync` + its tests (~1 hr).**
2. **Audit pass (~4 hr).** Spreadsheet-style: enumerate every try/catch (use `grep -n "try {" src --include="*.ts" -A2`), categorize a/b/c, label.
3. **Migrate bucket (b) — log-and-continue (~2 hr).** Mechanical replacement.
4. **Migrate bucket (c) — propagate (~1 hr).** More careful; needs caller adjustments.
5. **Annotate bucket (a) — keep but document (~30 min).**
6. **Add ESLint rule banning bare `catch {}` (~30 min).** Force future code to choose explicitly.

## Acceptance criteria

- `safeAsync` exists, tested
- 0 occurrences of `catch {}` or `catch (\w+) {\s*}` in production code (lint rule enforces)
- Every try/catch either uses `safeAsync` or has a `// silently ok:` comment
- All tests still pass
- A regression test: simulate a `deleteForumTopic` rejection during reconciliation, confirm `topic-manager` logs `topic.delete failed` (instead of swallowing)

## Risks

- **Spurious log volume.** Adding logs to ~150 sites that currently silently retry could spam. Mitigation: use `debug` severity by default for repeat-in-loop sites; `warn` for one-shot.
- **Breaking control flow.** Bucket (c) migrations could surface latent bugs (something was depending on the swallow). Mitigation: do those last, with extra test coverage.
- **Audit fatigue.** 214 sites is a lot. Mitigation: split the audit across team if applicable; or accept that some buckets are categorised by file rather than per-site.

## Out of scope

- Structured error types / discriminated unions (premature for this codebase)
- Sentry/external error reporting wiring (could come later)
- Distinguishing recoverable vs non-recoverable at the type level
