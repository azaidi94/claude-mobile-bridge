#!/bin/bash
# Run every test file in its own `bun test` process (isolation: a shared
# process leaks module/global state between files). Unlike a naive
# `|| exit 1` loop, this runs ALL files, records every failure, and exits
# non-zero at the end — so CI reports the full set of failures in one run
# instead of masking everything after the first failing file.

set -uo pipefail

export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-test-token}"
export TELEGRAM_ALLOWED_USERS="${TELEGRAM_ALLOWED_USERS:-1}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

failed=()
total=0

# Scan all of src/, not just src/__tests__ — tests co-located with their module
# (src/relay/discovery.test.ts, src/sessions/resolve-session.test.ts, …) are a
# real pattern here and were silently never running.
for f in $(find src -name '*.test.ts' | sort); do
  total=$((total + 1))
  if ! bun test "$f"; then
    failed+=("$f")
  fi
done

echo ""
echo "──────────────────────────────────────────"
if [ ${#failed[@]} -ne 0 ]; then
  echo "❌ ${#failed[@]}/${total} test file(s) failed:"
  printf '   %s\n' "${failed[@]}"
  exit 1
fi
echo "✅ all ${total} test file(s) passed"
