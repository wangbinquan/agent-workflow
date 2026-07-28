#!/bin/sh
# Stub opencode binary for the RFC-234 intent-builder Playwright spec.
#
# Same CLI surface as stub-opencode.sh (`--version` + `run … -- <prompt>`),
# but the emitted envelope speaks the intent protocol: a `summary` port plus a
# `changeset` port carrying one agent-create op. The nonce is echoed from the
# prompt (RFC-200); a missing nonce is a hard failure so a protocol regression
# cannot silently pass.

set -eu

case "${1-}" in
  --version|-v|version)
    echo "stub-opencode intent-build"
    exit 0
    ;;
  run)
    : # fallthrough
    ;;
  *)
    echo "stub-opencode-intent: unsupported mode: ${*:-<no args>}" >&2
    exit 2
    ;;
esac

RAW_PROMPT=""
_seen_dd=0
for _a in "$@"; do
  if [ "$_seen_dd" = 1 ]; then RAW_PROMPT="$_a"; break; fi
  [ "$_a" = "--" ] && _seen_dd=1
done
envelope_nonce=$(printf '%s\n' "$RAW_PROMPT" | sed -n 's/.*nonce="\([^"]*\)".*/\1/p' | tail -n 1)
if [ -z "$envelope_nonce" ]; then
  echo "stub-opencode-intent: prompt is missing the RFC-200 envelope nonce" >&2
  exit 3
fi

output_open='<workflow-output nonce=\"'"$envelope_nonce"'\">'
changeset='{\"$schema_version\":1,\"ops\":[{\"opId\":\"op-1\",\"action\":\"create\",\"resourceType\":\"agent\",\"tempRef\":\"$new:e2e-auditor\",\"payload\":{\"name\":\"e2e-auditor\",\"description\":\"audits code for e2e\",\"outputs\":[\"findings\"],\"bodyMd\":\"You audit.\"}}]}'
envelope="$output_open"'\n  <port name=\"summary\">stub intent build: one auditor agent</port>\n  <port name=\"changeset\">'"$changeset"'</port>\n</workflow-output>'

printf '{"type":"text","timestamp":0,"part":{"type":"text","text":"%s"}}\n' "$envelope"
exit 0
