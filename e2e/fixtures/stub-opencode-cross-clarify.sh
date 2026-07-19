#!/bin/sh
# Stub opencode for RFC-056 cross-clarify e2e (agent-driven; updated for RFC-162).
#
# The stub keys purely on (agent, invocation-count) — it does NOT force a fixed
# round order, so it works unchanged under RFC-162's questioner-rerun sequence.
# Under RFC-162 (cross-clarify reruns the QUESTIONER asker, not the designer):
#
#   designer round 1:   emit <workflow-output> "design v1"  (runs ONCE — no
#                       designer-by-default rerun after the cross submit).
#   questioner round 1: emit <workflow-clarify> with a single question.
#   *** task pauses awaiting_human; user POSTs answers (continue) ***
#   questioner round 2: RFC-100 mandatory ask-back — emit <workflow-clarify>
#                       AGAIN. The prompt now carries the flat `## Clarify Q&A`
#                       block (RFC-132 PR-C: the runner injects the user's Q&A as
#                       a single flat block into the ASKER's rerun). Stub logs the
#                       received prompt to $CROSS_CLARIFY_PROMPT_LOG so the spec
#                       can grep `questioner round 2`.
#   *** pauses; user POSTs answers (stop) ***
#   questioner round 3: emit <workflow-output> "questioner v3" — final output.
#
# Required env:
#   CROSS_CLARIFY_STUB_STATE   directory the runner can read+write counter files in.
# Optional env:
#   CROSS_CLARIFY_PROMPT_LOG   absolute file path; if set, stub appends the
#                              decoded prompt body (positional arg to `run`)
#                              before each emit so the spec can assert that
#                              round 3 contains "## Clarify Q&A".

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
    echo "stub-opencode-cross-clarify: unsupported mode: ${*:-<no args>}" >&2
    exit 2
    ;;
esac

state_dir="${CROSS_CLARIFY_STUB_STATE:-/tmp/aw-e2e-cross-clarify-state}"
mkdir -p "$state_dir"

# Capture prompt (first positional after 'run') before flag-parsing eats it.
shift
RAW_PROMPT="${1-}"
envelope_nonce=$(printf '%s\n' "$RAW_PROMPT" | sed -n 's/.*nonce="\([^"]*\)".*/\1/p' | tail -n 1)
if [ -z "$envelope_nonce" ]; then
  echo "stub-opencode-cross-clarify: prompt is missing the RFC-200 envelope nonce" >&2
  exit 3
fi
output_open='<workflow-output nonce=\"'"$envelope_nonce"'\">'
clarify_open='<workflow-clarify nonce=\"'"$envelope_nonce"'\">'
agent="default"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent)
      shift
      agent="${1-default}"
      ;;
  esac
  shift || true
done
agent_key=$(printf '%s' "$agent" | tr -c 'A-Za-z0-9._-' '_')
counter_file="$state_dir/$agent_key.count"

# Bump counter atomically.
count=1
if [ -f "$counter_file" ]; then
  count=$(($(cat "$counter_file") + 1))
fi
printf '%s' "$count" > "$counter_file"

# Append the prompt body to the prompt log (if configured).
if [ -n "${CROSS_CLARIFY_PROMPT_LOG:-}" ]; then
  {
    printf '=== %s round %s ===\n' "$agent" "$count"
    printf '%s\n' "$RAW_PROMPT"
    printf '=== END %s round %s ===\n' "$agent" "$count"
  } >> "$CROSS_CLARIFY_PROMPT_LOG"
fi

# Decide what to emit based on (agent, count).
# RFC-100: the questioner has a clarify channel ⇒ mandatory ask-back. A
# 'continue' answer makes it ask AGAIN (it may not finalize until 'stop'), so the
# questioner emits a cross-clarify question on BOTH its first (count 1) and its
# cascade-rerun (count 2) invocations; only after the user answers with 'stop'
# does its third invocation (count 3) emit <workflow-output>.
if [ "$agent" = "questioner" ] && [ "$count" -le 2 ]; then
  # questioner.first (count 1) + questioner.cascade (count 2): emit a cross-clarify question.
  body='{\"questions\":[{\"id\":\"q-redis\",\"title\":\"Should we use Redis for caching?\",\"kind\":\"single\",\"recommended\":true,\"options\":[\"Yes\",\"No\",\"Maybe\"]}]}'
  printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"$clarify_open$body</workflow-clarify>\"}}"
  exit 0
fi

# All other rounds: emit <workflow-output>. Designer outputs "design"; questioner
# outputs "main"; payload text encodes the round so the spec can verify ordering.
case "$agent" in
  designer)
    port="design"
    text="design v$count"
    ;;
  questioner)
    port="main"
    text="questioner v$count: all good"
    ;;
  *)
    port="design"
    text="other v$count"
    ;;
esac
printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"$output_open\\n  <port name=\\\"$port\\\">$text</port>\\n</workflow-output>\"}}"
exit 0
