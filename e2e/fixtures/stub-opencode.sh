#!/bin/sh
# Stub opencode binary for Playwright e2e (P-5-07).
#
# Two modes:
#   --version           prints a version line that satisfies MIN_OPENCODE_VERSION.
#   run <prompt> ...    emits one --format=json text event carrying a
#                       <workflow-output> envelope, then exits 0.
#
# The envelope content is fixed: a single port "answer" with value
# "stub e2e output". The companion test creates an agent whose declared
# outputs are exactly ["answer"], so the runner parses cleanly. RFC-200
# requires the response envelope to echo the nonce from the prompt.
#
# All other args (--agent / --format / --dangerously-skip-permissions /
# the prompt itself) are ignored — we don't care what the daemon asked
# for; we just need the runner to see a well-formed envelope.

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
    echo "stub-opencode: unsupported mode: ${*:-<no args>}" >&2
    exit 2
    ;;
esac

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
  echo "stub-opencode: prompt is missing the RFC-200 envelope nonce" >&2
  exit 3
fi
output_open='<workflow-output nonce=\"'"$envelope_nonce"'\">'

# RFC-187 T11 (audit TRAP-3): be WORKGROUP-AWARE. A workgroup host run (leader /
# worker / fc member) is fed the wg protocol block and is projected onto wg_* ports
# only (RFC-184), so the fixed "answer" envelope below parses to ZERO declared ports
# → the turn fails → the group task ends `failed`. The Playwright workgroup spec then
# "passed" on a failed group, which is exactly why production ran 10 tasks / 0 done
# without a single red test. Detect the role from the prompt (the protocol block names
# the ports it demands) and emit the matching envelope. Non-workgroup runs are
# untouched: no wg_* marker in the prompt ⇒ the original "answer" envelope, byte-identical.
# Match the protocol block's own port DECLARATIONS (`<port name="wg_decision">`), not a
# bare token: a leader's ledger quotes member results and could otherwise be misread.
WG_PROMPT="$RAW_PROMPT"
wg_envelope=''
case "$WG_PROMPT" in
  *'name="wg_decision"'*)
    # leader: close the group immediately (empty assignments = no new work).
    wg_envelope="$output_open"'\n  <port name=\"wg_assignments\">[]</port>\n  <port name=\"wg_decision\">{\"action\":\"done\",\"summary\":\"stub e2e leader done\"}</port>\n</workflow-output>'
    ;;
  *'name="wg_task_results"'*)
    # RFC-215 fc TASK-BATCH run: the protocol demands one entry per Task number
    # (1..N, prompt says "batch of N"); wg_result is explicitly ruled out for
    # this run kind. Matched BEFORE wg_result so the batch protocol's prose
    # mention of wg_result can never shadow this branch.
    wg_batch_n=$(printf '%s' "$WG_PROMPT" | sed -n 's/.*batch of \([0-9][0-9]*\).*/\1/p' | head -1)
    [ -n "$wg_batch_n" ] || wg_batch_n=1
    wg_entries=''
    wg_i=1
    while [ "$wg_i" -le "$wg_batch_n" ]; do
      [ -n "$wg_entries" ] && wg_entries="$wg_entries,"
      wg_entries="$wg_entries{\\\"task\\\":$wg_i,\\\"summary\\\":\\\"stub e2e batch task $wg_i done\\\"}"
      wg_i=$((wg_i + 1))
    done
    wg_envelope="$output_open"'\n  <port name=\"wg_task_results\">['"$wg_entries"']</port>\n  <port name=\"wg_tasks_add\">[]</port>\n</workflow-output>'
    ;;
  *'name="wg_result"'*)
    # lw worker / fc message turn: report done, add no follow-up tasks
    # (wg_tasks_add is fc-only; a worker never declares it, so the projection
    # just drops it).
    wg_envelope="$output_open"'\n  <port name=\"wg_result\">{\"summary\":\"stub e2e member result\"}</port>\n  <port name=\"wg_tasks_add\">[]</port>\n</workflow-output>'
    ;;
esac
if [ -n "$wg_envelope" ]; then
  printf '{"type":"text","timestamp":0,"part":{"type":"text","text":"%s"}}\n' "$wg_envelope"
  exit 0
fi

# JSON-encoded text event. The runner reads --format json line-by-line and
# concatenates `part.text` from each `text` event, then extracts the last
# <workflow-output> envelope from that buffer. One event with the whole
# envelope is sufficient.
# RFC-029: when the framework asks for an inventory drop (by setting
# OPENCODE_AW_INVENTORY_OUT), simulate what the real aw-inventory-dump
# plugin would have written. Keeps existing main.spec.ts cases unaffected
# while letting the inventory-section spec exercise the captured:true path.
if [ -n "${OPENCODE_AW_INVENTORY_OUT:-}" ]; then
  cat > "${OPENCODE_AW_INVENTORY_OUT}" <<'INVENTORY_JSON'
{
  "schemaVersion": 1,
  "capturedAt": 1700000000000,
  "agents": [
    {"name": "e2e-stub-coder", "mode": "primary", "modelProviderId": "anthropic", "modelId": "claude-opus-4-7", "readonly": true, "source": "inline"}
  ],
  "skills": [
    {"name": "fixture-skill", "source": "managed", "path": "/tmp/skills/fixture-skill", "description": "stub e2e skill"}
  ],
  "mcps": [
    {"name": "fixture-mcp-ok", "type": "local", "status": "connected", "hint": null},
    {"name": "fixture-mcp-warn", "type": "remote", "status": "needs_auth", "hint": "token missing"}
  ],
  "plugins": [
    {"specifier": "file:///tmp/plugins/aw-inventory-dump.mjs", "source": "inline"}
  ]
}
INVENTORY_JSON
fi

printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"$output_open\\n  <port name=\\\"answer\\\">stub e2e output</port>\\n</workflow-output>\"}}"
exit 0
