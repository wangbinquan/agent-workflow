import type {
  TriggerContext,
  TriggerDependencyIssue,
  TriggerDependencySource,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import type { ExecutionScopeIndex } from '../../domain/executionScope'
import type { TaskEngineKind, TaskScopeOutcome } from '../../domain/taskEngine'
import type { TaskRepositoryMount } from '../../domain/taskRepository'
import type { ResolvedTaskDriveConfig } from '../drive/taskDriveTypes'
import type { DynamicWorkflowPersistence } from './dynamicWorkflowPersistence'
import type { Logger } from './executionKernel'
import type { HumanGateTaskLifecycle } from './humanGateTaskLifecycle'
import type {
  TaskEngineApplicationPersistence,
  TaskEngineCollaboratorSnapshot,
  TaskEngineTaskSnapshot,
} from './taskEngineApplicationPersistence'
import type { TaskExecutionContextRef } from './taskExecutionTopology'
import type { TaskOwnershipPersistence } from './taskOwnershipPersistence'
import type { TaskRuntimeLifecyclePersistence } from './taskRuntimeLifecyclePersistence'

/**
 * RFC-408 — the facts the task control plane has established before a drive: the composition
 * assembles the execution state from them. `Admission` is the task-execution resource session the
 * admission port returned; the control plane only hands it back.
 */
export interface TaskDrivePreparation<Admission> {
  readonly task: TaskEngineTaskSnapshot
  readonly collaborators: readonly TaskEngineCollaboratorSnapshot[]
  readonly admission: Admission
  readonly definition: WorkflowDefinition
  readonly repos: TaskRepositoryMount[]
  readonly triggerContext: TriggerContext | null
  readonly inputsMap: Record<string, string>
  readonly scopeIndex: ExecutionScopeIndex
  readonly containerOf: Map<string, string>
  readonly topLevelIds: Set<string>
}

/** RFC-408 — one assembled drive: recovery, the three engine bodies and the post-drive inspection. */
export interface PreparedTaskDrive {
  /** RFC-130 T3c2 pending-merge recovery before the scope runs. */
  recoverBeforeScope(): Promise<void>
  /** Each engine body over the assembled execution state, returning its raw scope outcome. */
  readonly bodies: Readonly<Record<TaskEngineKind, () => Promise<TaskScopeOutcome>>>
  /** The production drive configuration (throws when the runtime options are incomplete). */
  runtimeConfig(): ResolvedTaskDriveConfig
  /** RFC-248 AC-19 read-only member dirtiness report. */
  inspectReadonlyRepos(): Promise<void>
}

/**
 * RFC-408 — capabilities of the task control plane (`engine/task/runTask.ts`). Every value is read
 * when the control plane asks for it; implementations of other contexts and of `services/` are bound
 * in composition.
 */
export interface TaskRunPorts<Admission> {
  readonly taskId: string
  readonly log: Logger
  /** The logger the terminal-write helpers have always used for lost-CAS warnings. */
  readonly settlementLog: Logger
  readonly execution: TaskExecutionContextRef | undefined
  readonly signal: AbortSignal | undefined
  readonly persistence: {
    readonly drive: TaskEngineApplicationPersistence
    readonly ownership: TaskOwnershipPersistence
    readonly runtimeLifecycle: TaskRuntimeLifecyclePersistence
    readonly humanGateLifecycle: HumanGateTaskLifecycle
  }
  readonly admission: {
    /** The task-execution resource session when the owner's execution authority is available. */
    admit(input: {
      readonly ownerUserId: string | null
      readonly taskId: string
    }): Promise<Admission | null>
  }
  readonly workspace: {
    readonly ensureProfiles: boolean
    project(
      task: TaskEngineTaskSnapshot,
      rows: readonly TaskRepositoryMount[],
    ): TaskRepositoryMount[]
    ensureExcludeProfile(input: {
      readonly workspaceRef: string
      readonly directChildMounts: string[]
    }): Promise<{ readonly version: number; readonly digest: string }>
  }
  readonly rules: {
    triggerPreflightIssue(args: {
      root: WorkflowDefinition
      closureJson: string | null
      source: TriggerDependencySource
    }): TriggerDependencyIssue | null
  }
  /** Absent when dynamic-workflow operations are not composed. */
  readonly dynamicWorkflow: Pick<DynamicWorkflowPersistence, 'loadTask'> | undefined
  readonly reviewMutation: {
    run<T>(fn: () => Promise<T>): Promise<T>
  }
  prepare(input: TaskDrivePreparation<Admission>): PreparedTaskDrive
}
