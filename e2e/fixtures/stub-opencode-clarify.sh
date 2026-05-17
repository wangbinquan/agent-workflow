#!/bin/sh
# Stub opencode for RFC-023 PR-D clarify e2e (T28 + T29).
#
# Behaviour: round-driven. The fixture writes a small counter file at
# `$CLARIFY_STUB_STATE` and decides which envelope to emit based on whether
# the agent has been called before for this (agent, shard_key) pair.
#
# Round 1 (no prior counter): emit <workflow-clarify> with 2 questions —
#   first "recommended", second not. UI must render the recommended chip
#   on Q1 and gate the submit button on Q1.
# Round 2 (counter exists): emit <workflow-output> with the declared port
#   `design` carrying "design after clarify <agent> <shard>".
#
# The shard discrimination keys on $MOCK_OPENCODE_SHARD_KEY when present so
# the agent-multi fan-out sub-case (T29) can route each shard through a
# different round counter.
#
# Required env:
#   CLARIFY_STUB_STATE   directory the runner can read+write counter files in.
# Optional env:
#   MOCK_OPENCODE_SHARD_KEY  shard discriminator for agent-multi.
#   CLARIFY_STUB_ASK_SHARDS  whitespace-separated list of shard_keys that
#                            should ask back on round 1. When set, shards
#                            NOT in the list emit the final output envelope
#                            on their very first call (skipping clarify).
#                            Used by T29 (1 of 3 shards asks back).

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
    echo "stub-opencode-clarify: unsupported mode: ${*:-<no args>}" >&2
    exit 2
    ;;
esac

state_dir="${CLARIFY_STUB_STATE:-/tmp/aw-e2e-clarify-state}"
mkdir -p "$state_dir"

# Derive a per-(agent, shard_key) counter key. The agent name comes from
# --agent <name>; loop the argv to find it.
agent="default"
shift  # drop the leading 'run'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent)
      shift
      agent="${1-default}"
      ;;
  esac
  shift || true
done
shard="${MOCK_OPENCODE_SHARD_KEY:-_none_}"
key="$state_dir/$(printf '%s' "$agent.$shard" | tr -c 'A-Za-z0-9._-' '_')"

# Decide whether THIS invocation should clarify or finalise.
ask_list="${CLARIFY_STUB_ASK_SHARDS:-}"
should_ask=1
if [ -n "$ask_list" ]; then
  should_ask=0
  for s in $ask_list; do
    if [ "$s" = "$shard" ]; then
      should_ask=1
      break
    fi
  done
fi

# First call → clarify (if eligible). Second+ call → output.
already_called=0
if [ -f "$key" ]; then
  already_called=1
fi
# Bump the counter for future calls.
printf 'x' >> "$key"

if [ "$already_called" -eq 0 ] && [ "$should_ask" -eq 1 ]; then
  # First call AND this shard is supposed to ask: emit clarify envelope.
  body='{"questions":[{"id":"q-db","title":"Which database should we use?","kind":"single","recommended":true,"options":["Postgres","SQLite"]},{"id":"q-lang","title":"Pick languages","kind":"multi","recommended":false,"options":["TypeScript","Python"]}]}'
  printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"<workflow-clarify>$body</workflow-clarify>\"}}"
  exit 0
fi

# Final round: emit <workflow-output>. Single port named "design".
text="design after clarify $agent $shard"
printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"<workflow-output>\\n  <port name=\\\"design\\\">$text</port>\\n</workflow-output>\"}}"
exit 0
