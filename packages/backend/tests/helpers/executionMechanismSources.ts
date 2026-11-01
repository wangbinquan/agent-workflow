// Source locks follow the actual owners, including the script attempt callbacks.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '../../src/modules/task-execution')
export const SCRIPT_NODE_SOURCE = readFileSync(
  resolve(root, 'engine/node/script/runScriptNode.ts'),
  'utf8',
)
export const SCRIPT_ATTEMPT_SOURCE = readFileSync(
  resolve(root, 'engine/node/script/runOneScriptAttempt.ts'),
  'utf8',
)
export const MERGE_CONFLICT_SOURCE = readFileSync(
  resolve(root, 'engine/node/shared/resolveMergeConflicts.ts'),
  'utf8',
)

// RFC-403: fixed source corpora include each moved body once, with explicit owners.
export const CODE_HOST_NODE_SOURCE = readFileSync(
  resolve(root, 'engine/node/code-host-call/runCodeHostCallNode.ts'),
  'utf8',
)
export const INPUT_NODE_SOURCE = readFileSync(
  resolve(root, 'engine/node/input/runInputNode.ts'),
  'utf8',
)
export const OUTPUT_NODE_SOURCE = readFileSync(
  resolve(root, 'engine/node/output/runOutputNode.ts'),
  'utf8',
)
export const REVIEW_NODE_SOURCE = readFileSync(
  resolve(root, 'engine/node/review/reviewNodeExecutor.ts'),
  'utf8',
)
export const IDLE_CLARIFY_SOURCE = readFileSync(
  resolve(root, 'engine/node/clarify/settleIdleClarify.ts'),
  'utf8',
)
export const CROSS_CLARIFY_SOURCE = readFileSync(
  resolve(root, 'engine/node/clarify-cross-agent/runCrossClarifyNode.ts'),
  'utf8',
)
export const NODE_BRANCH_SOURCE = readFileSync(
  resolve(root, 'application/nodeBranchActivation.ts'),
  'utf8',
)
export const NODE_INPUTS_SOURCE = readFileSync(resolve(root, 'application/nodeInputs.ts'), 'utf8')

// RFC-404: the shared call-workflow / call-workgroup body and its two launch arms.
export const CHILD_CALL_NODE_SOURCE = readFileSync(
  resolve(root, 'engine/node/shared/child-call/runChildCallNode.ts'),
  'utf8',
)
export const CHILD_CALL_LAUNCH_SOURCE = readFileSync(
  resolve(root, 'engine/node/shared/child-call/launchChildCall.ts'),
  'utf8',
)

/** Every leaf body moved out of nodeMechanics.ts (RFC-403, RFC-404), so corpora stay complete. */
export const LEAF_NODE_SOURCES = [
  CODE_HOST_NODE_SOURCE,
  INPUT_NODE_SOURCE,
  OUTPUT_NODE_SOURCE,
  REVIEW_NODE_SOURCE,
  IDLE_CLARIFY_SOURCE,
  CROSS_CLARIFY_SOURCE,
  NODE_BRANCH_SOURCE,
  NODE_INPUTS_SOURCE,
  CHILD_CALL_NODE_SOURCE,
  CHILD_CALL_LAUNCH_SOURCE,
] as const
