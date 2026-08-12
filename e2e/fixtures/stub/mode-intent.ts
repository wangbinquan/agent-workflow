// RFC-254 T28b — `intent` mode: the port of `stub-opencode-intent.sh` (RFC-234).
//
// Same CLI surface as `basic`, but the envelope speaks the intent protocol:
// a `summary` port plus a `changeset` port carrying create ops.
//
// The old `intent-workflow-opencode.sh` was a two-line launcher that exported
// `STUB_INTENT_VARIANT=workflow` and exec'd this stub. In the ported form that
// is not a separate mode at all — it is the same mode with the same variable,
// which is why the frozen contract listed it separately but the implementation
// does not need to. Its deliberate exclusion from the version-telemetry stub
// matrix is preserved by the fact that it never had its own version string.

import { emitTextEvent, parseInvocation, requireOutputOpen } from './skeleton'

const NAME = 'stub-opencode-intent'

const AGENT_CHANGESET =
  '{"$schema_version":1,"ops":[{"opId":"op-1","action":"create","resourceType":"agent","tempRef":"$new:e2e-auditor","payload":{"name":"e2e-auditor","description":"audits code for e2e","outputs":["findings"],"bodyMd":"You audit."}}]}'

const WORKFLOW_CHANGESET =
  '{"$schema_version":1,"ops":[{"opId":"op-1","action":"create","resourceType":"agent","tempRef":"$new:e2e-workflow-worker","payload":{"name":"e2e-workflow-worker","description":"handles and reviews workflow requests","outputs":["draft","answer"],"bodyMd":"Complete the requested work."}},{"opId":"op-2","action":"create","resourceType":"workflow","tempRef":"$new:e2e-workflow","payload":{"name":"e2e-workflow-preview","description":"workflow graph preview fixture","definition":{"$schema_version":5,"inputs":[],"nodes":[{"id":"worker","kind":"agent-single","agentRef":"$new:e2e-workflow-worker","promptTemplate":"Produce a draft.","position":{"x":20,"y":120}},{"id":"reviewer","kind":"agent-single","agentRef":"$new:e2e-workflow-worker","promptTemplate":"Review the draft: {{draft}}","position":{"x":320,"y":120}},{"id":"final_output","kind":"output","ports":[{"name":"answer","bind":{"nodeId":"reviewer","portName":"answer"}}],"position":{"x":640,"y":120}}],"edges":[{"id":"worker_to_reviewer","source":{"nodeId":"worker","portName":"draft"},"target":{"nodeId":"reviewer","portName":"draft"}},{"id":"reviewer_to_output","source":{"nodeId":"reviewer","portName":"answer"},"target":{"nodeId":"final_output","portName":"answer"}}]}}}]}'

export function run(argv: readonly string[]): void {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode intent-build\n')
    process.exit(0)
  }
  const open = requireOutputOpen(call.prompt, NAME)

  const workflowVariant = process.env.STUB_INTENT_VARIANT === 'workflow'
  const changeset = workflowVariant ? WORKFLOW_CHANGESET : AGENT_CHANGESET
  const summary = workflowVariant
    ? 'stub intent build: workflow preview'
    : 'stub intent build: one auditor agent'

  emitTextEvent(
    `${open}\n  <port name="summary">${summary}</port>\n  <port name="changeset">${changeset}</port>\n</workflow-output>`,
  )
  process.exit(0)
}
