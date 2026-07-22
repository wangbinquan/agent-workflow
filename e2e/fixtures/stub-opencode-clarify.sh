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
# --agent <name>; loop the argv to find it. Capture the prompt (the
# positional after `--`) BEFORE the flag loop eats it, since we need it
# for shard-key extraction further down.
agent="default"
shift  # drop the leading 'run'
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
  echo "stub-opencode-clarify: prompt is missing the RFC-200 envelope nonce" >&2
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
  esac
  shift || true
done
shard="${MOCK_OPENCODE_SHARD_KEY:-_none_}"
key="$state_dir/$(printf '%s' "$agent.$shard" | tr -c 'A-Za-z0-9._-' '_')"

# Decide whether THIS invocation should clarify or finalise.
# The runner does NOT forward MOCK_OPENCODE_SHARD_KEY to subprocess env, so
# we fall back to extracting the shard from the prompt body. The fan-out
# spec uses promptTemplate `Audit {{__shard_key__}}.` so the rendered
# prompt always contains `Audit <shard_key>.`. We grep that.
ask_list="${CLARIFY_STUB_ASK_SHARDS:-}"
should_ask=1
if [ -n "$ask_list" ]; then
  should_ask=0
  prompt_shard=""
  for s in $ask_list; do
    # Look for the literal "Audit <shard>." anywhere in stdin / argv. The
    # prompt was passed as positional arg via $RAW_PROMPT (captured at the
    # top of the script before the flag-parsing loop ate the argv).
    case "$RAW_PROMPT" in
      *"Audit $s"*)
        prompt_shard="$s"
        should_ask=1
        break
        ;;
    esac
  done
  if [ -n "$prompt_shard" ]; then
    shard="$prompt_shard"
    key="$state_dir/$(printf '%s' "$agent.$shard" | tr -c 'A-Za-z0-9._-' '_')"
  fi
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
  body='{\"questions\":[{\"id\":\"q-db\",\"title\":\"Which database should we use?\",\"kind\":\"single\",\"recommended\":true,\"options\":[\"Postgres\",\"SQLite\"]},{\"id\":\"q-lang\",\"title\":\"Pick languages\",\"kind\":\"multi\",\"recommended\":false,\"options\":[\"TypeScript\",\"Python\"]}]}'
  printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"$clarify_open$body</workflow-clarify>\"}}"
  exit 0
fi

# Final round: emit <workflow-output>. Single port named "design".
text="design after clarify $agent $shard"
printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"$output_open\\n  <port name=\\\"design\\\">$text</port>\\n</workflow-output>\"}}"
exit 0
