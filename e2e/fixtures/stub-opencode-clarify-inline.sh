#!/bin/sh
# Stub opencode for RFC-026 PR-B T13 — inline clarify session-resume e2e.
#
# Differences from stub-opencode-clarify.sh:
#   1. ALWAYS pre-emits a `session.created` JSON event so the runner captures
#      a sessionId into RunResult.sessionId. Round 0 picks the stub's per-key
#      id; round 1 echoes back the `--session <id>` the runner forwards.
#   2. ALWAYS appends the full argv to `$CLARIFY_INLINE_ARGV_LOG` so the e2e
#      test can assert `--session opc_e2e_<key>` reaches round 1.
#   3. Same round-driven behaviour: first call emits <workflow-clarify>,
#      subsequent calls emit <workflow-output> with port `design`.
#
# Required env:
#   CLARIFY_STUB_STATE       directory for per-(agent, shard) counter files.
#   CLARIFY_INLINE_ARGV_LOG  path the stub appends `--session <id>` lines to.

set -eu

case "${1-}" in
  --version|-v|version)
    echo "stub-opencode 1.14.99"
    exit 0
    ;;
  run)
    : # fallthrough
    ;;
  *)
    echo "stub-opencode-clarify-inline: unsupported mode: ${*:-<no args>}" >&2
    exit 2
    ;;
esac

state_dir="${CLARIFY_STUB_STATE:-/tmp/aw-e2e-clarify-inline-state}"
mkdir -p "$state_dir"
argv_log="${CLARIFY_INLINE_ARGV_LOG:-$state_dir/argv.log}"

# Capture raw argv for the e2e to inspect.
printf '%s\n' "$*" >> "$argv_log"

# Walk argv: pick out --agent <name>, --session <id> if present, and
# RAW_PROMPT (the first positional arg after 'run').
agent="default"
session_resume=""
shift  # drop leading 'run'
RAW_PROMPT="${1-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent)
      shift
      agent="${1-default}"
      ;;
    --session)
      shift
      session_resume="${1-}"
      ;;
  esac
  shift || true
done

key="$state_dir/$(printf '%s' "$agent" | tr -c 'A-Za-z0-9._-' '_')"
session_id="opc_e2e_$(printf '%s' "$agent" | tr -c 'A-Za-z0-9._-' '_')"

# Always emit the session.created event so the runner persists sessionId.
# On round 1 the id is the same as round 0 (real opencode resume reuses
# the original session id), which mirrors production behaviour and lets
# the e2e assert "node_runs.opencode_session_id is the same across rounds".
printf '%s\n' "{\"type\":\"session.created\",\"sessionID\":\"$session_id\",\"timestamp\":0}"

already_called=0
if [ -f "$key" ]; then
  already_called=1
fi
printf 'x' >> "$key"

if [ "$already_called" -eq 0 ]; then
  body='{"questions":[{"id":"q-db","title":"Which database should we use?","kind":"single","recommended":true,"options":["Postgres","SQLite"]}]}'
  printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"<workflow-clarify>$body</workflow-clarify>\"}}"
  exit 0
fi

# Round 1: emit final <workflow-output>. The e2e separately greps
# CLARIFY_INLINE_ARGV_LOG to confirm `--session $session_id` was passed.
text="design after inline-clarify $agent (session=$session_resume)"
printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"<workflow-output>\\n  <port name=\\\"design\\\">$text</port>\\n</workflow-output>\"}}"
exit 0
