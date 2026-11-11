import type { WorkflowDefinition } from '@agent-workflow/shared'
import type { CollaborationRuntimeMechanics } from './collaborationRuntimeMechanics'
import type { NodeRunLedger, NodeRunIdentityFactory, Logger } from './executionKernel'
import type { NodeExecutionPersistence } from './nodeExecutionPersistence'
import type { RunSelectionReader } from './runSelection'
import type { NodeStatusEvents } from './nodeExecutionSupport'
import type { recordSkippedRun } from '../nodeBranchActivation'
import type { NodeStepRequest, NodeStepOutcome } from '../../domain/nodeExecution'

/** The three gates derive collaboration's exact offered contracts here, once. */
type HumanGateCollaboration = Pick<
  CollaborationRuntimeMechanics,
  'dispatchReviewNode' | 'inspectCrossClarify' | 'getNodeClarifyDirective'
>
type BoundGate<T extends (...args: never[]) => unknown> = (
  input: Omit<Parameters<T>[0], 'executionContext'>,
) => ReturnType<T>
export interface ReviewNodeExecutionPorts {
  readonly taskId: string
  readonly appHome: string
  readonly definition: WorkflowDefinition
  readonly scopeRoot: string
  readonly repoMounts: readonly string[]
  portFallbackMount(mounts: readonly string[]): string
  dispatchReviewNode: BoundGate<HumanGateCollaboration['dispatchReviewNode']>
}
export interface ClarifyNodeExecutionPorts {
  readonly taskId: string
  readonly log: Logger
  readonly rows: Pick<NodeExecutionPersistence, 'list'>
  readonly selection: Pick<RunSelectionReader, 'current'>
  recordSkippedRun(input: Parameters<typeof recordSkippedRun>[1]): Promise<string>
}
export interface CrossClarifyNodeExecutionPorts {
  readonly taskId: string
  readonly definition: WorkflowDefinition
  readonly rows: Pick<NodeExecutionPersistence, 'list'>
  readonly ledger: Pick<NodeRunLedger, 'mintNodeRun' | 'setNodeRunStatus'> & NodeRunIdentityFactory
  readonly status: NodeStatusEvents
  getNodeClarifyDirective: HumanGateCollaboration['getNodeClarifyDirective']
  inspectCrossClarify: BoundGate<HumanGateCollaboration['inspectCrossClarify']>
  settleIdleClarify(request: NodeStepRequest<'clarify-cross-agent'>): Promise<NodeStepOutcome>
}
