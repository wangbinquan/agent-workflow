import type { HumanGateNodeProjectionMember } from '../../domain/humanGateContinuation'
import type { TaskRollbackCheckpointRun } from '../../domain/taskCheckpointRollback'
import type { NodeExecutionSnapshot } from './nodeExecutionPersistence'

export interface NodeRunFactSnapshot extends Omit<
  NodeExecutionSnapshot,
  | 'rerunCause'
  | 'mergeState'
  | 'role'
  | 'syntheticKind'
  | 'attemptIndex'
  | 'checkpoints'
  | 'checkpointInheritance'
> {
  readonly rerunCause: string | null
  readonly mergeState: string | null
}

/** History retains internal identity metadata; display fields are restored from epoch-1 evidence. */
export interface NodeRunHistoryFactSnapshot extends Omit<NodeRunFactSnapshot, 'slot'> {
  readonly slot: NodeRunFactSnapshot['slot'] | null
  readonly identity: 'known' | 'unknown'
  readonly recordMode: 'executable' | 'history-only'
}

export interface NodeRunCheckpointSnapshot extends NodeRunFactSnapshot {
  readonly checkpoints: NodeExecutionSnapshot['checkpoints']
  readonly checkpointInheritance: NodeExecutionSnapshot['checkpointInheritance']
  readonly rollback: TaskRollbackCheckpointRun
}

/** 跨上下文只读事实；选择规则另由 RunSelectionReader 承担。 */
export interface NodeRunFactsQuery {
  readonly taskId?: string
  readonly taskIds?: readonly string[]
  readonly nodeId?: string
  readonly nodeIds?: readonly string[]
  readonly iteration?: number
  readonly runIds?: readonly string[]
  readonly shardKey?: string | null
  readonly parentNodeRunId?: string | null
  readonly reviewIteration?: number
  readonly status?: NodeRunFactSnapshot['status']
  readonly limit?: number
  readonly order?: 'seq-desc' | 'seq-asc' | 'retry-desc'
}

export type NodeRunDispatchFacts = Omit<
  Pick<
    NodeExecutionSnapshot,
    | 'id'
    | 'seq'
    | 'taskId'
    | 'nodeId'
    | 'status'
    | 'iteration'
    | 'retryIndex'
    | 'parentNodeRunId'
    | 'childTaskId'
    | 'shardKey'
    | 'wgRound'
    | 'reviewIteration'
    | 'mergeState'
    | 'forceActivated'
    | 'startedAt'
    | 'finishedAt'
    | 'pid'
    | 'exitCode'
    | 'errorMessage'
    | 'failureCode'
    | 'opencodeSessionId'
    | 'rerunCause'
    | 'supersededByReview'
    | 'rolledBack'
  >,
  'rerunCause' | 'mergeState'
> & { readonly rerunCause: string | null; readonly mergeState: string | null }

export interface NodeRunQueries {
  listHistory(input: NodeRunFactsQuery): Promise<readonly NodeRunHistoryFactSnapshot[]>
  listHistoryFields<K extends keyof NodeRunFactSnapshot>(
    input: NodeRunFactsQuery,
    fields: readonly K[],
  ): Promise<readonly Pick<NodeRunHistoryFactSnapshot, K>[]>

  heldSession(runId: string): Promise<{ readonly sessionId: string } | undefined>
  heldSessionRunIds(taskId: string): Promise<readonly string[]>
  listResumeRuns(
    taskId: string,
    mountPaths: readonly string[],
  ): Promise<readonly NodeRunCheckpointSnapshot[]>
  humanGateProjection(runIds: readonly string[]): Promise<readonly HumanGateNodeProjectionMember[]>
  listDispatchFacts(input: NodeRunFactsQuery): Promise<readonly NodeRunDispatchFacts[]>
  listHistoryDispatchFacts(input: NodeRunFactsQuery): Promise<readonly NodeRunDispatchFacts[]>
  latestHistoryPerNode(
    taskIds: readonly string[],
  ): Promise<
    readonly Pick<
      NodeRunHistoryFactSnapshot,
      'id' | 'taskId' | 'nodeId' | 'status' | 'retryIndex' | 'finishedAt'
    >[]
  >
  latestPerNode(
    taskIds: readonly string[],
  ): Promise<
    readonly Pick<
      NodeRunFactSnapshot,
      'id' | 'taskId' | 'nodeId' | 'status' | 'retryIndex' | 'finishedAt'
    >[]
  >
  readWithCheckpoints(runId: string): Promise<NodeRunCheckpointSnapshot | null>
  listWithCheckpoints(input: NodeRunFactsQuery): Promise<readonly NodeRunCheckpointSnapshot[]>
  readFields<K extends keyof NodeRunFactSnapshot>(
    runId: string,
    fields: readonly K[],
  ): Promise<Pick<NodeRunFactSnapshot, K> | null>
  listFields<K extends keyof NodeRunFactSnapshot>(
    input: NodeRunFactsQuery,
    fields: readonly K[],
  ): Promise<readonly Pick<NodeRunFactSnapshot, K>[]>
  read(runId: string): Promise<NodeRunFactSnapshot | null>
  list(input: NodeRunFactsQuery): Promise<readonly NodeRunFactSnapshot[]>
}
