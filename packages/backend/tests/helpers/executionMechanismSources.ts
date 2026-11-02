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

// RFC-406: the workgroup host lane of the same executor; nodeMechanics.ts is gone.
export const WORKGROUP_HOST_SOURCE = readFileSync(
  resolve(root, 'engine/node/agent-single/runWorkgroupHost.ts'),
  'utf8',
)
export const NODE_EXECUTION_SOURCE = readFileSync(
  resolve(root, 'composition/nodeExecution.ts'),
  'utf8',
)

// RFC-407: the fan-out shard / aggregator lines (RFC-287 L5 / L6) left wrapperMechanics.ts.
export const FANOUT_SHARD_SOURCE = readFileSync(
  resolve(root, 'engine/node/agent-single/runFanoutShard.ts'),
  'utf8',
)
export const FANOUT_AGGREGATOR_SOURCE = readFileSync(
  resolve(root, 'engine/node/agent-single/runFanoutAggregator.ts'),
  'utf8',
)
// RFC-413: the wrapper workspace (scenes, git entry snapshot, changed-file subtraction) and the wrapper iso
// create / merge-back left wrapperMechanics.ts for engine/wrapper/ and engine/kernel/.
export const WRAPPER_WORKSPACE_SOURCE = readFileSync(
  resolve(root, 'engine/wrapper/wrapperWorkspace.ts'),
  'utf8',
)
export const WRAPPER_ISOLATION_SOURCE = readFileSync(
  resolve(root, 'engine/kernel/wrapperIsolation.ts'),
  'utf8',
)
export const MERGE_RECOVERY_SOURCE = readFileSync(
  resolve(root, 'engine/kernel/mergeRecovery.ts'),
  'utf8',
)
export const WRAPPER_RUN_LEDGER_SOURCE = readFileSync(
  resolve(root, 'engine/wrapper/wrapperRunLedger.ts'),
  'utf8',
)

/**
 * RFC-407: what used to be the single `wrapperMechanics.ts` text — the file itself (wrapper data,
 * scope driver and workspace bindings), both fan-out lines and the attempt port they implement.
 * RFC-413: plus the wrapper workspace and the wrapper iso create / merge-back that moved into engine/.
 * RFC-420: plus the fan-out agent / source-port-kind resolution (`sourcePortKindOf`, shared with the
 * fan-out shard line through the agent binding) and the wrapper body's entry.
 */
export const WRAPPER_MECHANICS_SOURCE = [
  readFileSync(resolve(root, 'composition/wrapperMechanics.ts'), 'utf8'),
  FANOUT_SHARD_SOURCE,
  FANOUT_AGGREGATOR_SOURCE,
  readFileSync(resolve(root, 'engine/node/agent-single/fanoutAttempts.ts'), 'utf8'),
  WRAPPER_WORKSPACE_SOURCE,
  WRAPPER_ISOLATION_SOURCE,
  readFileSync(resolve(root, 'application/fanoutAgentResolution.ts'), 'utf8'),
  readFileSync(resolve(root, 'engine/wrapper/wrapperBodyScope.ts'), 'utf8'),
].join('\n')

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
 * RFC-405 / RFC-406: what used to be the single `nodeMechanics.ts` text for agent-path source locks —
 * both lanes of the agent-single executor (the DAG body and the workgroup host), their binding, the
 * run-history reads and retry decisions they moved into, and the workgroup engine hooks now in
 * `nodeExecution.ts`. Presence / absence locks and cross-owner counts keep their meaning; exact owners
 * are locked by `architecture/rfc405-agent-single-executor.test.ts` and `rfc406-workgroup-host-executor`.
 */
export const AGENT_MECHANICS_SOURCE = [
  AGENT_NODE_SOURCE,
  WORKGROUP_HOST_SOURCE,
  AGENT_BINDING_SOURCE,
  AGENT_RUN_HISTORY_SOURCE,
  ENVELOPE_RETRY_POLICY_SOURCE,
  NODE_EXECUTION_SOURCE,
].join('\n')

/** Every leaf body moved out of nodeMechanics.ts (RFC-403～406) and the fan-out lines (RFC-407). */
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
  WORKGROUP_HOST_SOURCE,
  FANOUT_SHARD_SOURCE,
  FANOUT_AGGREGATOR_SOURCE,
] as const
