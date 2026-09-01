import type { TriggerContext, WorkflowDefinition } from '@agent-workflow/shared'
import type { TaskEngineTaskSnapshot } from '@/modules/task-execution/application/ports/taskEngineApplicationPersistence'
import type { SchedulerRuntimeTopology } from '@/modules/task-execution/public/participants'
import type {
  TaskScopeOutcome,
  WrapperExecutionScopeReadModel,
} from '@/modules/task-execution/public/types'
import type { Logger } from '@/util/log'
import type { Semaphore } from '@/util/semaphore'
import type { BoundRunTaskOptions } from './taskEngineRuntimeOptions'
import type { TaskExecutionResourceSession } from './taskExecutionResources'

export interface TaskScopeArgs {
  /** Wrapper node that owns this scope; null for the workflow root. */
  readonly scopeId: string | null
  readonly scopeIds: Set<string>
  readonly iteration: number
  readonly log: Logger
}

export interface NodeMechanicsResult {
  readonly kind: 'ok' | 'failed' | 'canceled' | 'awaiting_review' | 'awaiting_human'
  readonly summary: string
  readonly message: string
  readonly processUnreaped?: true
}

/**
 * Post-W2-D compatibility state retained by the remaining node, lifecycle and
 * commit-push mechanics. Composition adapts it into purpose-specific ports; it
 * never appears in an application port or public submission contract. Later
 * waves delete fields as those remaining mechanics migrate.
 */
export interface TaskMechanicsState {
  readonly task: TaskEngineTaskSnapshot
  readonly taskId: string
  readonly definition: WorkflowDefinition
  readonly opts: BoundRunTaskOptions
  /** One authority-bound, immutable resource snapshot cache for this task run. */
  readonly taskExecutionResources: TaskExecutionResourceSession
  readonly collaboratorUserIds: readonly string[]
  readonly topology: SchedulerRuntimeTopology
  readonly log: Logger
  readonly inputsMap: Record<string, string>
  readonly triggerContext: TriggerContext | null
  readonly agentSem: Semaphore
  readonly scriptSem: Semaphore
  readonly codeHostSem: Semaphore
  readonly writeSem: Semaphore
  readonly subprocessSem: Semaphore
  readonly containerOf: Map<string, string>
  readonly topLevelIds: Set<string>
  readonly wrapperScopes: WrapperExecutionScopeReadModel
  readonly driveScope: (state: TaskMechanicsState, args: TaskScopeArgs) => Promise<TaskScopeOutcome>
  readonly repos: Array<{
    readonly repoIndex: number
    readonly repoPath: string
    readonly worktreePath: string
    readonly worktreeDirName: string
    readonly mountPath: string
    readonly readonly: boolean
    readonly baseBranch: string
    readonly baseCommit: string | null
  }>
  readonly scopeRoot: string
  readonly repoGroupName: string | null
}
