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

// RFC-405: the agent-single body.
export const AGENT_NODE_SOURCE = readFileSync(
  resolve(root, 'engine/node/agent-single/runAgentSingleNode.ts'),
  'utf8',
)

export const AGENT_BINDING_SOURCE = readFileSync(
  resolve(root, 'composition/agentNodeExecution.ts'),
  'utf8',
)
export const AGENT_RUN_HISTORY_SOURCE = readFileSync(
  resolve(root, 'application/agentRunHistory.ts'),
  'utf8',
)
export const ENVELOPE_RETRY_POLICY_SOURCE = readFileSync(
  resolve(root, 'domain/envelopeRetryPolicy.ts'),
  'utf8',
)
/**
 * RFC-405: what used to be the single `nodeMechanics.ts` text for agent-path source locks — the
 * agent body, its binding, the run-history reads and retry decisions it moved into, and the file
 * itself (still the workgroup host). Presence / absence locks and cross-owner counts keep their
 * meaning; exact owners are locked by `architecture/rfc405-agent-single-executor.test.ts`.
 */
export const AGENT_MECHANICS_SOURCE = [
  AGENT_NODE_SOURCE,
  AGENT_BINDING_SOURCE,
  AGENT_RUN_HISTORY_SOURCE,
  ENVELOPE_RETRY_POLICY_SOURCE,
  readFileSync(resolve(root, 'composition/nodeMechanics.ts'), 'utf8'),
].join('\n')

/** Every leaf body moved out of nodeMechanics.ts (RFC-403～405), so corpora stay complete. */
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
  AGENT_NODE_SOURCE,
] as const
