import type { TaskExecutionContextRef } from './taskExecutionTopology'
import type {
  TaskEngineContext,
  TaskEngineOutcome,
  TaskEngineSnapshot,
} from '../../domain/taskEngine'

export interface TaskEngineSnapshotRef {
  readonly taskId: string
  readonly execution: TaskExecutionContextRef
}

export interface TaskEngineStore {
  loadSnapshot(input: TaskEngineSnapshotRef): Promise<TaskEngineSnapshot | null>
  claimRunning(input: TaskEngineSnapshotRef): Promise<'claimed' | 'lost'>
  settle(
    input: TaskEngineSnapshotRef & { readonly outcome: TaskEngineOutcome },
  ): Promise<'settled' | 'lost'>
}

export interface RepositoryPreparationDescriptorRef {
  readonly taskId: string
  readonly execution: TaskExecutionContextRef
}

export type RepositoryPreparationOutcome =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'terminal-won' }>

export interface RepositoryPreparationPort {
  prepare(input: RepositoryPreparationDescriptorRef): Promise<RepositoryPreparationOutcome>
  discard(input: RepositoryPreparationDescriptorRef): Promise<void>
}

export interface NodeStepRequest {
  readonly taskId: string
  readonly nodeId: string
  readonly iteration: number
  readonly scopeId: string | null
}

export type NodeStepOutcome =
  | Readonly<{ kind: 'done' }>
  | Readonly<{ kind: 'failed'; summary: string }>
  | Readonly<{ kind: 'canceled' }>
  | Readonly<{ kind: 'awaiting_review' }>
  | Readonly<{ kind: 'awaiting_human' }>

export interface NestedScopeRequest {
  readonly taskId: string
  readonly scopeId: string
  readonly iteration: number
}

export interface NestedScopeDriver {
  drive(input: NestedScopeRequest): Promise<TaskEngineOutcome>
}

export interface LegacyNodeStepPort {
  execute(input: NodeStepRequest, nestedScope: NestedScopeDriver): Promise<NodeStepOutcome>
}

export interface WorkgroupHostExecutionRequest {
  readonly taskId: string
  readonly memberId: string
  readonly round: number
}

export type WorkgroupHostExecutionOutcome =
  | Readonly<{ kind: 'done' }>
  | Readonly<{ kind: 'failed'; summary: string }>
  | Readonly<{ kind: 'canceled' }>

export interface LegacyWorkgroupHostExecutionPort {
  execute(input: WorkgroupHostExecutionRequest): Promise<WorkgroupHostExecutionOutcome>
}

export interface TaskReplayRequest {
  readonly taskId: string
  readonly execution: TaskExecutionContextRef
}

export interface TaskPreDriveReplayPort {
  replayPendingMerges(input: TaskReplayRequest): Promise<void>
  replayConflictHumanResolutions(input: TaskReplayRequest): Promise<void>
}

export interface TaskCompletionRequest {
  readonly taskId: string
  readonly execution: TaskExecutionContextRef
}

export interface TaskCompletionEffectsPort {
  inspectReadonlyRepositories(input: TaskCompletionRequest): Promise<void>
  maybeCommitAndPush(input: TaskCompletionRequest): Promise<void>
}

export interface DagScopeDriverPort {
  driveTopLevel(context: TaskEngineContext): Promise<TaskEngineOutcome>
}

export interface WorkgroupTurnsDriverPort {
  driveTurns(context: TaskEngineContext): Promise<TaskEngineOutcome>
}

export interface DynamicWorkflowGenerationPort {
  generate(context: TaskEngineContext): Promise<TaskEngineOutcome>
}
