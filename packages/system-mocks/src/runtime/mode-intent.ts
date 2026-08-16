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
import { existsSync } from 'node:fs'

const NAME = 'stub-opencode-intent'

const AGENT_CHANGESET =
  '{"$schema_version":1,"ops":[{"opId":"op-1","action":"create","resourceType":"agent","tempRef":"$new:e2e-auditor","payload":{"name":"e2e-auditor","description":"audits code for e2e","outputs":["findings"],"bodyMd":"You audit."}}]}'

const OVERLAPPING_WORKFLOW_CHANGESET =
  '{"$schema_version":1,"ops":[{"opId":"op-1","action":"create","resourceType":"agent","tempRef":"$new:e2e-workflow-worker","payload":{"name":"e2e-workflow-worker","description":"handles and reviews workflow requests","outputs":["draft","answer"],"bodyMd":"Complete the requested work."}},{"opId":"op-2","action":"create","resourceType":"workflow","tempRef":"$new:e2e-workflow","payload":{"name":"e2e-workflow-preview","description":"workflow graph preview fixture","definition":{"$schema_version":5,"inputs":[],"nodes":[{"id":"worker","kind":"agent-single","agentRef":"$new:e2e-workflow-worker","promptTemplate":"Produce a draft.","position":{"x":0,"y":0}},{"id":"reviewer","kind":"agent-single","agentRef":"$new:e2e-workflow-worker","promptTemplate":"Review the draft: {{draft}}","position":{"x":0,"y":0}},{"id":"final_output","kind":"output","ports":[{"name":"answer","bind":{"nodeId":"reviewer","portName":"answer"}}],"position":{"x":0,"y":0}}],"edges":[{"id":"worker_to_reviewer","source":{"nodeId":"worker","portName":"draft"},"target":{"nodeId":"reviewer","portName":"draft"}},{"id":"reviewer_to_output","source":{"nodeId":"reviewer","portName":"answer"},"target":{"nodeId":"final_output","portName":"answer"}}]}}}]}'

// RFC-254 freezes the legacy workflow stub byte-for-byte. RFC-302 opts into
// the all-overlapping input above explicitly, without rewriting that contract.
const WORKFLOW_CHANGESET = OVERLAPPING_WORKFLOW_CHANGESET.replace(
  '"position":{"x":0,"y":0}',
  '"position":{"x":20,"y":120}',
)
  .replace('"position":{"x":0,"y":0}', '"position":{"x":320,"y":120}')
  .replace('"position":{"x":0,"y":0}', '"position":{"x":640,"y":120}')

const NESTED_CYCLE_WORKFLOW_CHANGESET = JSON.stringify({
  $schema_version: 1,
  ops: [
    {
      opId: 'op-1',
      action: 'create',
      resourceType: 'agent',
      tempRef: '$new:e2e-nested-cycle-worker',
      payload: {
        name: 'e2e-nested-cycle-worker',
        description: 'nested cycle worker',
        outputs: ['out'],
        bodyMd: 'Traverse the loop.',
      },
    },
    {
      opId: 'op-2',
      action: 'create',
      resourceType: 'workflow',
      tempRef: '$new:e2e-nested-cycle-workflow',
      payload: {
        name: 'e2e-nested-cycle-workflow',
        description: 'nested wrapper and legal loop cycle fixture',
        definition: {
          $schema_version: 5,
          inputs: [],
          nodes: [
            {
              id: 'outer_loop',
              kind: 'wrapper-loop',
              nodeIds: ['git_scope'],
              maxIterations: 3,
              exitCondition: { kind: 'port-empty', nodeId: 'worker_a', portName: 'out' },
              position: { x: 0, y: 0 },
            },
            {
              id: 'git_scope',
              kind: 'wrapper-git',
              nodeIds: ['worker_a', 'worker_b'],
              position: { x: 0, y: 0 },
            },
            {
              id: 'worker_a',
              kind: 'agent-single',
              agentRef: '$new:e2e-nested-cycle-worker',
              promptTemplate: 'A receives {{feedback}}.',
              position: { x: 0, y: 0 },
            },
            {
              id: 'worker_b',
              kind: 'agent-single',
              agentRef: '$new:e2e-nested-cycle-worker',
              promptTemplate: 'B receives {{feedback}}.',
              position: { x: 0, y: 0 },
            },
          ],
          edges: [
            {
              id: 'a_to_b',
              source: { nodeId: 'worker_a', portName: 'out' },
              target: { nodeId: 'worker_b', portName: 'feedback' },
            },
            {
              id: 'b_to_a',
              source: { nodeId: 'worker_b', portName: 'out' },
              target: { nodeId: 'worker_a', portName: 'feedback' },
            },
          ],
        },
      },
    },
  ],
})

export async function run(argv: readonly string[]): Promise<void> {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode intent-build\n')
    process.exit(0)
  }
  const open = requireOutputOpen(call.prompt, NAME)

  const workflowVariant = process.env.STUB_INTENT_VARIANT === 'workflow'
  const layoutFixture = process.env.STUB_INTENT_LAYOUT_FIXTURE
  const changeset = workflowVariant
    ? layoutFixture === 'overlap'
      ? OVERLAPPING_WORKFLOW_CHANGESET
      : layoutFixture === 'nested-cycle'
        ? NESTED_CYCLE_WORKFLOW_CHANGESET
        : WORKFLOW_CHANGESET
    : AGENT_CHANGESET
  const summary = workflowVariant
    ? 'stub intent build: workflow preview'
    : 'stub intent build: one auditor agent'

  const holdFile = process.env.STUB_INTENT_HOLD_FILE
  if (holdFile !== undefined) {
    const deadline = Date.now() + 30_000
    while (existsSync(holdFile) && Date.now() < deadline) {
      await new Promise((releaseCheck) => setTimeout(releaseCheck, 25))
    }
    if (existsSync(holdFile)) {
      throw new Error(`stub intent hold was not released within 30000ms: ${holdFile}`)
    }
  } else {
    const delayMs = Number.parseInt(process.env.STUB_INTENT_DELAY_MS ?? '0', 10)
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
    }
  }

  emitTextEvent(
    `${open}\n  <port name="summary">${summary}</port>\n  <port name="changeset">${changeset}</port>\n</workflow-output>`,
  )
  process.exit(0)
}
