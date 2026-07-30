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
case "${STUB_INTENT_VARIANT:-agent}" in
  workflow)
    changeset='{\"$schema_version\":1,\"ops\":[{\"opId\":\"op-1\",\"action\":\"create\",\"resourceType\":\"agent\",\"tempRef\":\"$new:e2e-workflow-worker\",\"payload\":{\"name\":\"e2e-workflow-worker\",\"description\":\"handles and reviews workflow requests\",\"outputs\":[\"draft\",\"answer\"],\"bodyMd\":\"Complete the requested work.\"}},{\"opId\":\"op-2\",\"action\":\"create\",\"resourceType\":\"workflow\",\"tempRef\":\"$new:e2e-workflow\",\"payload\":{\"name\":\"e2e-workflow-preview\",\"description\":\"workflow graph preview fixture\",\"definition\":{\"$schema_version\":4,\"inputs\":[],\"nodes\":[{\"id\":\"worker\",\"kind\":\"agent-single\",\"agentRef\":\"$new:e2e-workflow-worker\",\"promptTemplate\":\"Produce a draft.\",\"position\":{\"x\":20,\"y\":120}},{\"id\":\"reviewer\",\"kind\":\"agent-single\",\"agentRef\":\"$new:e2e-workflow-worker\",\"promptTemplate\":\"Review the draft: {{draft}}\",\"position\":{\"x\":320,\"y\":120}},{\"id\":\"final_output\",\"kind\":\"output\",\"ports\":[{\"name\":\"answer\",\"bind\":{\"nodeId\":\"reviewer\",\"portName\":\"answer\"}}],\"position\":{\"x\":640,\"y\":120}}],\"edges\":[{\"id\":\"worker_to_reviewer\",\"source\":{\"nodeId\":\"worker\",\"portName\":\"draft\"},\"target\":{\"nodeId\":\"reviewer\",\"portName\":\"draft\"}},{\"id\":\"reviewer_to_output\",\"source\":{\"nodeId\":\"reviewer\",\"portName\":\"answer\"},\"target\":{\"nodeId\":\"final_output\",\"portName\":\"answer\"}}]}}}]}'
    summary='stub intent build: workflow preview'
    ;;
  *)
    changeset='{\"$schema_version\":1,\"ops\":[{\"opId\":\"op-1\",\"action\":\"create\",\"resourceType\":\"agent\",\"tempRef\":\"$new:e2e-auditor\",\"payload\":{\"name\":\"e2e-auditor\",\"description\":\"audits code for e2e\",\"outputs\":[\"findings\"],\"bodyMd\":\"You audit.\"}}]}'
    summary='stub intent build: one auditor agent'
    ;;
esac
envelope="$output_open"'\n  <port name=\"summary\">'"$summary"'</port>\n  <port name=\"changeset\">'"$changeset"'</port>\n</workflow-output>'

printf '{"type":"text","timestamp":0,"part":{"type":"text","text":"%s"}}\n' "$envelope"
exit 0
