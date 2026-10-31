import type {
  IsoHandle,
  MergeBackConflict,
  MergeBackResult,
  DiscardLock,
} from '@/platform/contracts/isolationWorkspace'
import type { Logger } from '@/util/log'
import type {
  IsolationWorkspaceBinding,
  IsolationWorkspaceScope,
} from '@/modules/source-control/public/types'
import type { MergeStateLifecyclePersistence } from './mergeStateLifecyclePersistence'
import type { NodeExecutionPersistence } from './nodeExecutionPersistence'
import type { TaskArtifactPathQueries } from './taskArtifactPathQueries'
import type { TaskExecutionContextRef } from './taskExecutionTopology'
import type { NodeRunLifecyclePersistence, NodeRunMintInput } from './nodeRunLifecyclePersistence'
import type { RunSlot } from './runSelection'
import type { NodeRunMintGeneration } from '../nodeRunMintIdentity'

export type { Logger }
export type WriteSemLike = DiscardLock

/** The effect factory is bound by the caller to the existing persistence and owner context. */
export interface IsolationEffectRequest {
  readonly taskId: string
  readonly nodeRunId: string
  readonly kind: 'isolation-create' | 'isolation-merge' | 'workspace-cleanup'
  readonly stableActionOrdinal: string
  readonly candidateId: string
  readonly request: unknown
  readonly resourceKeys: readonly string[]
}
export interface IsolationEffectObserver {
  beforeAct(): Promise<void>
  succeed(receipt?: Readonly<Record<string, unknown>>): Promise<void>
  fail(error: unknown, receipt?: Readonly<Record<string, unknown>>): Promise<void>
}
export type IsolationEffectFactory = (
  input: IsolationEffectRequest,
) => IsolationEffectObserver | undefined

export interface ExecutionIsolationScope {
  chooseGeneration: IsolationWorkspaceScope['chooseGeneration']
  create(input: Parameters<IsolationWorkspaceScope['create']>[0]): Promise<IsoHandle>
}
export interface ExecutionIsolationWorkspace {
  acquire(binding: IsolationWorkspaceBinding): Promise<ExecutionIsolationScope>
  snapshotIsolatedWorkspace(handle: IsoHandle, log?: Logger): Promise<Record<string, string>>
  mergeIsolatedWorkspace(
    handle: IsoHandle,
    trees: Record<string, string>,
    log?: Logger,
    resolveSubConflict?: (conflict: MergeBackConflict) => Promise<{ resolved: boolean }>,
  ): Promise<MergeBackResult>
  repoRelForcedPaths(paths: readonly string[], mountPath: string): string[]
}
export interface IsolatedAgentRunBinding {
  readonly workspace: ExecutionIsolationWorkspace
  readonly artifactPaths: Pick<TaskArtifactPathQueries, 'forcedPaths'>
  readonly mergeStates: Pick<MergeStateLifecyclePersistence, 'transition' | 'tryTransition'>
  readonly nodeExecution: Pick<NodeExecutionPersistence, 'patch'>
  readonly createLocalEffectAttemptObserver: IsolationEffectFactory
  readonly executionContext?: TaskExecutionContextRef
}
export interface IsolationCleanupBinding {
  /** The caller preserves the original provider participation predicate and lookup timing. */
  cleanupEffectFactory(taskId: string): IsolationEffectFactory | undefined
  discardIsolatedWorkspace(
    handle: IsoHandle,
    log?: Logger,
    writeSem?: DiscardLock,
    onProgress?: (partialFailures: number) => void,
  ): Promise<void | { readonly retained: true }>
}

type WithoutContext<T> = Omit<T, 'executionContext'>
export interface NodeRunLedger {
  executionContextInput(): { readonly executionContext?: TaskExecutionContextRef }
  mintNodeRun(
    input: WithoutContext<Parameters<NodeRunLifecyclePersistence['mint']>[0]>,
  ): Promise<string>
  setNodeRunStatus(
    input: WithoutContext<Parameters<NodeRunLifecyclePersistence['set']>[0]>,
  ): ReturnType<NodeRunLifecyclePersistence['set']>
  transitionNodeRunStatus(
    input: WithoutContext<Parameters<NodeRunLifecyclePersistence['transition']>[0]>,
  ): ReturnType<NodeRunLifecyclePersistence['transition']>
  loadEnvelopeNonce(nodeRunId: string): Promise<string>
}

export interface NodeRunIdentityFactory {
  nodeRunMintIdentityForSlot(
    slot: RunSlot,
    generation: NodeRunMintGeneration,
  ): Pick<
    NodeRunMintInput,
    'role' | 'syntheticKind' | 'slot' | 'executionGeneration' | 'envelopeNonce'
  >
}
