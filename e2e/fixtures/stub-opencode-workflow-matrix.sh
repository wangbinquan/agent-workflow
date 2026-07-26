#!/bin/sh
# Deterministic OpenCode stub for e2e/workflow-matrix.spec.ts.
#
# The real daemon, scheduler, DB, wrapper scopes, worktrees and output parser
# remain in the path. Only the external model process is replaced. Each
# example workflow carries a MATRIX_* prompt marker that selects one branch
# below. RFC-200's nonce is still required and echoed exactly.

set -eu

case "${1-}" in
  --version | -v | version)
    echo "stub-opencode workflow-matrix"
    exit 0
    ;;
  run)
    : # fall through
    ;;
  *)
    echo "stub-opencode-workflow-matrix: unsupported mode: ${*:-<no args>}" >&2
    exit 2
    ;;
esac

RAW_PROMPT=""
_seen_dd=0
for _arg in "$@"; do
  if [ "$_seen_dd" = 1 ]; then
    RAW_PROMPT="$_arg"
    break
  fi
  [ "$_arg" = "--" ] && _seen_dd=1
done

[ -n "${AW_STUB_PROMPT_OUT:-}" ] && printf '%s' "$RAW_PROMPT" >"$AW_STUB_PROMPT_OUT"

envelope_nonce=$(printf '%s\n' "$RAW_PROMPT" | sed -n 's/.*nonce="\([^"]*\)".*/\1/p' | tail -n 1)
if [ -z "$envelope_nonce" ]; then
  echo "stub-opencode-workflow-matrix: prompt is missing the RFC-200 envelope nonce" >&2
  exit 3
fi
output_open='<workflow-output nonce=\"'"$envelope_nonce"'\">'
clarify_open='<workflow-clarify nonce=\"'"$envelope_nonce"'\">'

if [ -n "${OPENCODE_AW_INVENTORY_OUT:-}" ]; then
  printf '%s\n' \
    '{"schemaVersion":1,"capturedAt":1700000000000,"agents":[],"skills":[],"mcps":[],"plugins":[]}' \
    >"$OPENCODE_AW_INVENTORY_OUT"
fi

emit_ports() {
  _ports=$1
  printf '%s\n' \
    "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"$output_open$_ports</workflow-output>\"}}"
}

emit_clarify() {
  _questions=$1
  printf '%s\n' \
    "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"$clarify_open$_questions</workflow-clarify>\"}}"
}

prompt_input() {
  _input_name=$1
  printf '%s\n' "$RAW_PROMPT" |
    sed -n '/<aw-input name="'"$_input_name"'"/ { n; p; q; }' |
    head -n 1
}

require_prompt() {
  _needle=$1
  case "$RAW_PROMPT" in
    *"$_needle"*) ;;
    *)
      echo "stub-opencode-workflow-matrix: prompt missing expected content: $_needle" >&2
      exit 10
      ;;
  esac
}

iteration=$(printf '%s\n' "$RAW_PROMPT" | sed -n 's/.*iteration=\([0-9][0-9]*\).*/\1/p' | head -n 1)
[ -n "$iteration" ] || iteration=0

case "$RAW_PROMPT" in
  *MATRIX_PROMPT_INPUTS*)
    require_prompt 'literal {{auto_text}}'
    require_prompt 'thorough'
    require_prompt '## auto_text'
    require_prompt 'auto-appended'
    require_prompt '## files'
    require_prompt 'docs/a.md'
    require_prompt 'docs/b.md'
    require_prompt '## tags'
    require_prompt '["api","docs"]'
    require_prompt '## branch'
    require_prompt '{"kind":"branch","ref":"main"}'
    require_prompt 'node=prompt_auditor'
    require_prompt 'iteration=0'
    require_prompt 'repo_count=1'
    emit_ports '<port name=\"report\">prompt-input-context-ok</port>'
    ;;
  *MATRIX_UPLOAD_INPUT*)
    [ -f matrix-uploads/one.md ] || {
      echo "missing uploaded file matrix-uploads/one.md" >&2
      exit 11
    }
    [ -f matrix-uploads/two.md ] || {
      echo "missing uploaded file matrix-uploads/two.md" >&2
      exit 11
    }
    require_prompt 'matrix-uploads/one.md'
    require_prompt 'matrix-uploads/two.md'
    emit_ports '<port name=\"report\">upload-roundtrip-ok</port>'
    ;;
  *MATRIX_OUTPUT_KINDS*)
    mkdir -p matrix-generated/kinds
    printf '# One file\n' >matrix-generated/kinds/one.md
    printf '# Two file\n' >matrix-generated/kinds/two.md
    emit_ports '<port name=\"text\">plain-value</port><port name=\"markdown\"># Inline document</port><port name=\"file\">matrix-generated/kinds/one.md</port><port name=\"names\">alpha\nbeta</port><port name=\"documents\"># First document\n<!-- @@aw-doc-boundary@@ -->\n# Second document</port><port name=\"files\">matrix-generated/kinds/one.md\nmatrix-generated/kinds/two.md</port><port name=\"done_signal\">ignored-signal-body</port>'
    ;;
  *MATRIX_SOURCE_A*)
    emit_ports '<port name=\"part\">alpha-fragment</port>'
    ;;
  *MATRIX_SOURCE_B*)
    emit_ports '<port name=\"part\">beta-fragment</port>'
    ;;
  *MATRIX_MERGE*)
    emit_ports '<port name=\"answer\">merged-alpha-beta</port>'
    ;;
  *MATRIX_GIT_MUTATE*)
    mkdir -p matrix-generated/docs
    printf 'generated source\n' >matrix-generated/source.txt
    printf '# generated document\n' >matrix-generated/docs/report.md
    emit_ports '<port name=\"note\">git-mutation-complete</port>'
    ;;
  *MATRIX_GIT_SUMMARY*)
    emit_ports '<port name=\"answer\">git-summary-complete</port>'
    ;;
  *MATRIX_GIT_NOOP*)
    emit_ports '<port name=\"note\">observed-without-changes</port>'
    ;;
  *MATRIX_LOOP_EMPTY*)
    if [ "$iteration" -eq 0 ]; then
      emit_ports '<port name=\"status\">continue</port><port name=\"items\">alpha\nbeta</port>'
    else
      emit_ports '<port name=\"status\"></port><port name=\"items\">complete</port>'
    fi
    ;;
  *MATRIX_LOOP_EQUALS*)
    if [ "$iteration" -eq 0 ]; then
      emit_ports '<port name=\"status\">continue</port><port name=\"items\">alpha\nbeta</port>'
    else
      emit_ports '<port name=\"status\">done</port><port name=\"items\">complete</port>'
    fi
    ;;
  *MATRIX_LOOP_COUNT*)
    if [ "$iteration" -eq 0 ]; then
      emit_ports '<port name=\"status\">continue</port><port name=\"items\">alpha\nbeta\ngamma</port>'
    else
      emit_ports '<port name=\"status\">done</port><port name=\"items\">only-one</port>'
    fi
    ;;
  *MATRIX_LOOP_EXHAUST*)
    emit_ports '<port name=\"status\">continue</port><port name=\"items\">still-pending</port>'
    ;;
  *MATRIX_NESTED_MUTATE*)
    mkdir -p matrix-generated/nested
    printf 'nested iteration %s\n' "$iteration" >"matrix-generated/nested/iter-$iteration.txt"
    emit_ports '<port name=\"note\">nested-mutation-complete</port>'
    ;;
  *MATRIX_NESTED_CHECK*)
    if [ "$iteration" -eq 0 ]; then
      emit_ports '<port name=\"status\">continue</port><port name=\"items\">pending</port>'
    else
      emit_ports '<port name=\"status\">done</port><port name=\"items\">complete</port>'
    fi
    ;;
  *MATRIX_FANOUT_WORKER*)
    doc=$(prompt_input doc)
    [ -n "$doc" ] || doc=unknown
    if [ "$doc" = "docs/fail.md" ]; then
      echo "intentional fanout shard failure: $doc" >&2
      exit 9
    fi
    emit_ports '<port name=\"finding\">finding:'"$doc"'</port>'
    ;;
  *MATRIX_FANOUT_MUTATE*)
    doc=$(prompt_input doc)
    [ -n "$doc" ] || doc=unknown
    doc_base=$(basename "$doc" .md)
    mkdir -p matrix-generated/fanout
    printf 'generated from %s\n' "$doc" >"matrix-generated/fanout/$doc_base.txt"
    emit_ports '<port name=\"finding\">mutated:'"$doc"'</port>'
    ;;
  *MATRIX_FANOUT_AGG*)
    emit_ports '<port name=\"report\">aggregated-fanout-report</port>'
    ;;
  *MATRIX_LOOP_FANOUT_AGG*)
    if [ "$iteration" -eq 0 ]; then
      emit_ports '<port name=\"status\">continue</port><port name=\"report\">fanout-generation-0</port>'
    else
      emit_ports '<port name=\"status\">done</port><port name=\"report\">fanout-generation-1</port>'
    fi
    ;;
  *MATRIX_SELF_CLARIFY*)
    case "$RAW_PROMPT" in
      *"Choose a delivery mode"*)
        emit_ports '<port name=\"answer\">self-clarify-complete</port>'
        ;;
      *)
        emit_clarify \
          '{\"questions\":[{\"id\":\"q-self\",\"title\":\"Choose a delivery mode\",\"kind\":\"single\",\"recommended\":true,\"options\":[\"safe\",\"fast\"]}]}'
        ;;
    esac
    ;;
  *MATRIX_CROSS_DESIGN*)
    emit_ports '<port name=\"design\">cross-design-v1</port>'
    ;;
  *MATRIX_CROSS_QUESTION*)
    case "$RAW_PROMPT" in
      *"Which trade-off should win?"*)
        emit_ports '<port name=\"answer\">cross-clarify-complete</port>'
        ;;
      *)
        emit_clarify \
          '{\"questions\":[{\"id\":\"q-cross\",\"title\":\"Which trade-off should win?\",\"kind\":\"single\",\"recommended\":false,\"options\":[\"latency\",\"consistency\"]}]}'
        ;;
    esac
    ;;
  *MATRIX_REVIEW_WRITE*)
    case "$RAW_PROMPT" in
      *"## Review Rejection"*)
        emit_ports '<port name=\"answer\">review-ready-document-v2</port>'
        ;;
      *)
        emit_ports '<port name=\"answer\">review-ready-document-v1</port>'
        ;;
    esac
    ;;
  *MATRIX_RUNTIME*)
    runtime_mode=$(prompt_input mode)
    runtime_task=$(printf '%s\n' "$RAW_PROMPT" | sed -n 's/^task=//p' | head -n 1)
    [ -n "$runtime_task" ] || runtime_task=unknown
    case "$runtime_mode" in
      retry)
        state_dir=${MATRIX_STATE_DIR:-.}
        mkdir -p "$state_dir"
        state_file="$state_dir/retry-$runtime_task"
        if [ ! -f "$state_file" ]; then
          : >"$state_file"
          echo "intentional first-attempt failure" >&2
          exit 12
        fi
        emit_ports '<port name=\"result\">retry-recovered</port>'
        ;;
      fail)
        echo "intentional permanent runtime failure" >&2
        exit 13
        ;;
      timeout | cancel)
        sleep 10
        emit_ports '<port name=\"result\">unexpected-slow-completion</port>'
        ;;
      *)
        echo "unknown MATRIX_RUNTIME mode: $runtime_mode" >&2
        exit 14
        ;;
    esac
    ;;
  *)
    echo "stub-opencode-workflow-matrix: no MATRIX_* marker in prompt" >&2
    exit 4
    ;;
esac

exit 0
