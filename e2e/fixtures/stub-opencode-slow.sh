#!/bin/sh
# RFC-054 W1-3 / W1-4 — slow + controllable variant of stub-opencode.sh.
# Used by e2e/crash-recovery.spec.ts (W1-3) to keep a task in `running` long
# enough to SIGKILL the daemon, and by e2e/task-lifecycle-states.spec.ts
# (W1-4) to drive failure / no-envelope / non-zero-exit paths.
#
# Controls (env var):
#   STUB_OPENCODE_SLEEP_MS       integer; defaults to 0 (no sleep — behaves
#                                like the fast stub). Floor-divided to whole
#                                seconds for portable `sleep` because /bin/sh
#                                on macOS doesn't support fractional sleeps.
#   STUB_OPENCODE_EXIT_CODE      integer; defaults to 0. Set to 1 (or any
#                                non-zero) to simulate an exploded agent;
#                                runner marks node_run failed.
#   STUB_OPENCODE_SKIP_ENVELOPE  any non-empty value → omit the
#                                <workflow-output> envelope line. Combined
#                                with EXIT_CODE=0 this models "agent ran
#                                cleanly but produced no envelope" (runner
#                                detects missing envelope → fails the run).
#
# Behavior is otherwise identical to stub-opencode.sh: a single text event
# carries the <workflow-output> envelope, exit 0.

set -eu

case "${1-}" in
  --version | -v | version)
    echo "stub-opencode 0.9.0"
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
  echo "stub-opencode-slow: prompt is missing the RFC-200 envelope nonce" >&2
  exit 3
fi
output_open='<workflow-output nonce=\"'"$envelope_nonce"'\">'

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

if [ -z "${STUB_OPENCODE_SKIP_ENVELOPE:-}" ]; then
  printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"$output_open\\n  <port name=\\\"answer\\\">stub e2e output</port>\\n</workflow-output>\"}}"
fi

exit "${STUB_OPENCODE_EXIT_CODE:-0}"
