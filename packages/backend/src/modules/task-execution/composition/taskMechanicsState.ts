// RFC-412: moved from services/execution/taskMechanicsState.ts — the execution state is an assembly type and lives
// only in composition (RFC-294 S6 exit gate).
import type { TriggerContext, WorkflowDefinition } from '@agent-workflow/shared'
import type { TaskEngineTaskSnapshot, TaskRepositoryMount } from '../public/types'
import type { SchedulerRuntimeTopology } from '../public/participants'
import type { TaskScopeOutcome, WrapperExecutionScopeReadModel } from '../public/types'
import type { Logger } from '@/util/log'
import type { Semaphore } from '@/platform/contracts/semaphore'
import type { BoundRunTaskOptions } from './taskEngineRuntimeOptions'
import type { DagScopeArgs } from '../application/ports/dagScope'
import type { TaskAgentResourceSession } from '@/services/execution/taskExecutionResources'

/**
 * One scope invocation: the wrapper that owns it (null at the workflow root) and its RFC-354 frame. RFC-420: the
 * DAG scope's own argument type (`application/ports/dagScope.ts`), which this state's scope driver receives.
 */
export type TaskScopeArgs = DagScopeArgs

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
  readonly taskExecutionResources: TaskAgentResourceSession
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
  readonly repos: TaskRepositoryMount[]
  readonly scopeRoot: string
  readonly repoGroupName: string | null
}
