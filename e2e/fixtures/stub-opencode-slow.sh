#!/bin/sh
# RFC-054 W1-3 — slow variant of stub-opencode.sh that sleeps before emitting
# its envelope. Used by e2e/crash-recovery.spec.ts to keep a task in `running`
# while the spec SIGKILLs the daemon mid-flight.
#
# Controls (env var):
#   STUB_OPENCODE_SLEEP_MS   integer; defaults to 0 (no sleep — behaves like
#                            the fast stub). Floor-divided to whole seconds
#                            for portable `sleep` because /bin/sh on macOS
#                            doesn't support fractional sleeps.
#
# Behavior is otherwise identical to stub-opencode.sh: a single text event
# carries the <workflow-output> envelope, exit 0.

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
    echo "stub-opencode-slow: unsupported mode: ${*:-<no args>}" >&2
    exit 2
    ;;
esac

sleep_ms="${STUB_OPENCODE_SLEEP_MS:-0}"
# Whole-second floor; macOS /bin/sh sleep doesn't accept decimals.
sleep_s=$((sleep_ms / 1000))
if [ "$sleep_s" -gt 0 ]; then
  # If the daemon SIGKILLs us mid-sleep, that's fine — the child will be
  # detached and reaped by init.
  sleep "$sleep_s"
fi

# Emit RFC-029 inventory drop if requested (parity with stub-opencode.sh so
# the inventory section happy-paths don't break when the slow stub is used).
if [ -n "${OPENCODE_AW_INVENTORY_OUT:-}" ]; then
  cat >"${OPENCODE_AW_INVENTORY_OUT}" <<'INVENTORY_JSON'
{
  "schemaVersion": 1,
  "capturedAt": 1700000000000,
  "agents": [
    {"name": "e2e-stub-coder", "mode": "primary", "modelProviderId": "anthropic", "modelId": "claude-opus-4-7", "readonly": true, "source": "inline"}
  ],
  "skills": [],
  "mcps": [],
  "plugins": []
}
INVENTORY_JSON
fi

printf '%s\n' '{"type":"text","timestamp":0,"part":{"type":"text","text":"<workflow-output>\n  <port name=\"answer\">stub e2e output</port>\n</workflow-output>"}}'
exit 0
