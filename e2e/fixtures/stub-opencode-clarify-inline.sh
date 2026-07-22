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
# RAW_PROMPT (the positional after the `--` end-of-options separator).
agent="default"
session_resume=""
shift  # drop leading 'run'
# The prompt is the SINGLE positional after buildCommand's `--` end-of-options
# separator (`run --agent … -- <prompt>`), exactly as the TS fixtures read it.
# Reading `$*` instead folds every flag into RAW_PROMPT and makes this stub blind
# to an argv-layout regression — see tests/e2e-shell-stub-argv-contract.test.ts.
RAW_PROMPT=""
_seen_dd=0
for _a in "$@"; do
  if [ "$_seen_dd" = 1 ]; then RAW_PROMPT="$_a"; break; fi
  [ "$_a" = "--" ] && _seen_dd=1
done
# Contract-test hook: echo the extracted prompt verbatim so the guard can assert
# the stub parsed the REAL prompt, not a flag or the whole argv.
[ -n "${AW_STUB_PROMPT_OUT:-}" ] && printf '%s' "$RAW_PROMPT" >"$AW_STUB_PROMPT_OUT"
envelope_nonce=$(printf '%s\n' "$RAW_PROMPT" | sed -n 's/.*nonce="\([^"]*\)".*/\1/p' | tail -n 1)
if [ -z "$envelope_nonce" ]; then
  echo "stub-opencode-clarify-inline: prompt is missing the RFC-200 envelope nonce" >&2
  exit 3
fi
output_open='<workflow-output nonce=\"'"$envelope_nonce"'\">'
clarify_open='<workflow-clarify nonce=\"'"$envelope_nonce"'\">'
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

# Contract/e2e oracle hook (Codex 191bc32c re-review): record the PARSED --session
# value — empty when the flag is absent — so the e2e asserts the real resume id
# from the FLAG, not by grepping the whole argv for `--session` (which a prompt
# carrying `--session`-like body text would fool).
[ -n "${CLARIFY_INLINE_SESSION_LOG:-}" ] && printf '%s\n' "$session_resume" >>"$CLARIFY_INLINE_SESSION_LOG"

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
  body='{\"questions\":[{\"id\":\"q-db\",\"title\":\"Which database should we use?\",\"kind\":\"single\",\"recommended\":true,\"options\":[\"Postgres\",\"SQLite\"]}]}'
  printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"$clarify_open$body</workflow-clarify>\"}}"
  exit 0
fi

# Round 1: emit final <workflow-output>. The e2e separately greps
# CLARIFY_INLINE_ARGV_LOG to confirm `--session $session_id` was passed.
text="design after inline-clarify $agent (session=$session_resume)"
printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"$output_open\\n  <port name=\\\"design\\\">$text</port>\\n</workflow-output>\"}}"
exit 0
