// RFC-413 — the ports of the kernel's pre-drive merge recovery and wrapper isolation
// (engine/kernel/mergeRecovery.ts, engine/kernel/wrapperIsolation.ts). The composition binds them over one
// execution state; every value is read when the kernel asks for it, exactly as the moved bodies read the state.
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import type { Semaphore } from '@/platform/contracts/semaphore'
import type { IsoSubmoduleTopology } from '../../domain/isoSubmodules'
import type { TaskRepositoryMount } from '../../domain/taskRepository'
import type { ExecutionWorkspaceSession } from './executionWorkspaceSession'
import type { IsolatedAgentRunBinding, IsolationCleanupBinding, Logger } from './executionKernel'
import type { MergeConflictResolver } from './mergeConflictResolution'
import type { MergeStateLifecyclePersistence } from './mergeStateLifecyclePersistence'
import type { NodeExecutionPersistence } from './nodeExecutionPersistence'
import type { TaskArtifactPathQueries } from './taskArtifactPathQueries'
import type { TaskExecutionContextRef } from './taskExecutionTopology'

/** The isolation scope of the execution state's canonical repositories. */
export type IsolationScope = Awaited<ReturnType<ExecutionWorkspaceSession['scope']>>

/** A restore request as the kernel builds it; the binding converts the persisted submodule topology. */
export type IsolationRestoreRequest = Omit<
  Parameters<ExecutionWorkspaceSession['restore']>[0],
  'submodules'
> & {
  readonly submodules?: IsoSubmoduleTopology
}

export interface HumanConflictOutcome {
  readonly allResolved: boolean
  readonly unresolvedRepos: string[]
}

export interface IsolationMechanicsPorts {
  readonly taskId: string
  readonly appHome: string
  readonly repos: TaskRepositoryMount[]
  readonly execution: TaskExecutionContextRef | undefined
  readonly writeSem: Semaphore
  /** The execution state's own log (wrapper isolation creates and cleans up under it). */
  readonly log: Logger
  /** A fresh kernel binding on every read, as each original call site built one. */
  readonly binding: IsolatedAgentRunBinding
  /** A fresh cleanup binding on every read, as each original call site built one. */
  readonly cleanup: IsolationCleanupBinding
  readonly persistence: {
    readonly nodeExecution: Pick<NodeExecutionPersistence, 'read' | 'list'>
    readonly mergeStates: Pick<MergeStateLifecyclePersistence, 'transition' | 'tryTransition'>
    readonly artifactPaths: Pick<TaskArtifactPathQueries, 'forcedPaths'>
  }
  readonly workspace: {
    scope(): Promise<IsolationScope>
    restore(request: IsolationRestoreRequest): Promise<IsoHandle>
  }
  /** The merge agent; its ports are built only when a conflict is resolved. */
  readonly conflicts: MergeConflictResolver
  /** Complete a human-resolved conflict in the handle's own scope (the kernel holds the write lock). */
  completeHumanConflict(
    handle: IsoHandle,
    nodeTrees: Record<string, string>,
    log: Logger,
  ): Promise<HumanConflictOutcome>
}
