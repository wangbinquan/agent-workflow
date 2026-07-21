#!/bin/sh
# RFC-075 e2e stub opencode. Two run roles, switched on the prompt:
#   * commit agent  (prompt mentions commit_message) → emits a commit message
#     envelope and writes nothing.
#   * worker agent  (any other prompt) → dirties the worktree (so the
#     framework's diff-driven commit trigger fires) and emits its output port.
# Event shape matches e2e/fixtures/stub-opencode.sh exactly (the daemon reads
# --format json and concatenates part.text).

set -eu

case "${1-}" in
  --version | -v | version)
    echo "stub-opencode 1.14.99"
    exit 0
    ;;
  run)
    : # fallthrough
    ;;
  *)
    echo "stub-opencode-commit: unsupported mode: ${*:-<no args>}" >&2
    exit 2
    ;;
esac

RAW_PROMPT="$*"
envelope_nonce=$(printf '%s\n' "$RAW_PROMPT" | sed -n 's/.*nonce="\([^"]*\)".*/\1/p' | tail -n 1)
if [ -z "$envelope_nonce" ]; then
  echo "stub-opencode-commit: prompt is missing the RFC-200 envelope nonce" >&2
  exit 3
fi
output_open='<workflow-output nonce=\"'"$envelope_nonce"'\">'

case "$*" in
  *commit_message*)
    printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"$output_open<port name=\\\"commit_message\\\">feat: e2e stub commit</port></workflow-output>\"}}"
    ;;
  *)
    # Dirty the worktree (cwd is the task worktree) so a commit is warranted.
    printf 'e2e change %s\n' "$$" > e2e-change.txt
    printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"$output_open<port name=\\\"answer\\\">stub e2e output</port></workflow-output>\"}}"
    ;;
esac
exit 0
