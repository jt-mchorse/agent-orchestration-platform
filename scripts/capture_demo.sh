#!/usr/bin/env bash
# Deterministic driver for the 60-second README demo (issue #16).
#
# Runs the two demo surfaces from the README's Demo section in sequence
# on a fresh clone with no API key and no Postgres:
#
#   1. npm run eval -- --dry-run       — prints the rendered
#                                        sticky-comment markdown +
#                                        composite / per-fixture table
#                                        on stdout. The fixtures are
#                                        committed under fixtures/sample-prs/
#                                        so this is hermetic.
#
#   2. npm run trace:server -- --memory  — boots the trace viewer with
#                                          MemoryStore (D-006: no
#                                          bundler, ESM-CDN React UI)
#                                          seeded with two synthetic
#                                          runs so the empty state
#                                          doesn't ship. The script
#                                          curls /api/runs to show the
#                                          shape the React UI consumes,
#                                          then SIGTERMs the server.
#
# The output is the recording — when JT records the GIF/video, this
# script's stdout (plus a manual browser tour during the trace-server
# section) is what gets captured. Hermetic: no API key, no Postgres,
# no network.
#
# Why curl /api/runs instead of opening a browser: this driver runs in
# CI too (test/capture-demo-smoke.test.ts) and can't drive a browser
# without Playwright/Puppeteer (heavy new dep). The /api/runs JSON is
# what the React UI consumes, so locking its shape via curl-then-
# assert is the same protection from a different angle.
#
# Variables:
#   CAPTURE_PACE_SECONDS  pause between sections (default 2 for
#                         recording; test/capture-demo-smoke.test.ts
#                         sets this to 0).
#   CAPTURE_TRACE_PORT    port for the trace server (default 8766 —
#                         matches the server's own default).
#
# Exit: 0 on full success; non-zero on any sub-step failure. The
# background trace server is reaped via EXIT trap.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACE="${CAPTURE_PACE_SECONDS:-2}"
PORT="${CAPTURE_TRACE_PORT:-8766}"

banner() {
  printf '\n'
  printf '═══ %s\n' "$1"
  printf '\n'
}

pace() {
  if [ "$PACE" != "0" ]; then
    sleep "$PACE"
  fi
}

cd "$REPO_ROOT"

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    # Give the server a moment to release the port; ignore errors so
    # the trap is safe to fire from any exit path.
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

banner "agent-orchestration-platform · 60-second demo"
printf 'two surfaces · fixture-driven eval · MemoryStore trace viewer\n'
printf 'no API key · no Postgres · no network\n'
pace

banner "1/2 · npm run eval -- --dry-run · rendered sticky-comment markdown + composite"
printf 'tsx src/bin/eval-runner.ts --dry-run\n'
printf '  scores every fixture under fixtures/sample-prs/ against its .golden.json\n'
printf '  rendered markdown is what the GH Action posts (in-place via sticky marker).\n\n'
npm run eval --silent -- --dry-run
pace

banner "2/2 · npm run trace:server -- --memory · seeded MemoryStore + /api/runs JSON"
printf 'tsx src/bin/trace-server.ts --memory   (port %s)\n' "$PORT"
printf '  MemoryStore seeded with two synthetic runs (D-006: no bundler, ESM-CDN React UI)\n'
printf '  curl /api/runs to show the shape the React UI consumes; SIGTERM via EXIT trap.\n\n'

PORT="$PORT" npm run trace:server --silent -- --memory >/dev/null 2>&1 &
SERVER_PID=$!
printf 'server pid %s; waiting for port to bind...\n' "$SERVER_PID"

# Poll the port instead of sleeping a fixed amount: faster locally,
# more robust on slower CI machines. Cap at 5 s — if the server isn't
# up by then something is wrong.
for _ in $(seq 1 25); do
  if (echo > /dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then
    break
  fi
  sleep 0.2
done

printf '\nGET /api/runs:\n\n'
curl -s "http://127.0.0.1:$PORT/api/runs"
printf '\n'
pace

banner "done · eval renderer + trace viewer wired end-to-end on hermetic fixtures"
printf 'next stop for real PRs:\n'
printf '  export DATABASE_URL=postgres://...    # PgStore real persistence\n'
printf '  npm run eval                          # against real fixtures or live PRs\n'
printf '  npm run trace:server                  # serves /api/runs from Postgres\n'
printf 'for the browser tour JT records separately:\n'
printf '  open http://127.0.0.1:%s/             # React + ESM-CDN viewer\n' "$PORT"
