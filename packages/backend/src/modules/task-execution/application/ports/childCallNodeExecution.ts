import type { TaskStatus, TriggerContext, WorkflowDefinition } from '@agent-workflow/shared'
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import type { TaskRepositoryCheckpoint } from '../../domain/taskCheckpoint'
import type {
  ChildWorkflowLaunchRequest,
  ChildWorkgroupLaunchRequest,
} from './childExecutionLaunchOperations'
import type { Logger } from './executionKernel'
import type { MergeConflictResolver } from './mergeConflictResolution'
import type { NodeExecutionPersistence } from './nodeExecutionPersistence'
import type { NodeStatusEvents } from './nodeExecutionSupport'
import type { ScriptInputPort, ScriptRunLedger, ScriptWorkspacePort } from './scriptNodeExecution'

// RFC-404 — explicit capabilities of the call-workflow / call-workgroup body. Every value is read when
// the body asks for it; nothing is frozen when the gateway is built.

type WithoutContext<T> = Omit<T, 'executionContext'>

/** Task facts the call body reads (getters bound to the running task). */
export interface ChildCallTaskFacts {
  readonly taskId: string
  readonly name: string
  /** RFC-271 T6e: v2 closures key call edges by this workflow anchor id plus the node id. */
  readonly workflowAnchorId: string
  readonly refClosureJson: string | null
  readonly invocationDepth: number
  readonly parentTaskId: string | null
  readonly ownerUserId: string | null
  readonly worktreePath: string
  readonly branch: string | null
  readonly repos: readonly { readonly mountPath: string; readonly worktreePath: string }[]
  readonly collaboratorUserIds: readonly string[]
  readonly triggerContext: TriggerContext | null
}

export interface ChildCallFrozenWorkflow {
  readonly id: string
  readonly version: number
  readonly definition: WorkflowDefinition
}
export type ChildCallFrozenWorkgroup = ChildWorkgroupLaunchRequest['frozenGroup']
export interface ChildCallEdgeSource {
  readonly workflowId: string
  readonly nodeId: string
}

/** The frozen call closure stored on the task row. */
export interface ChildCallClosurePort {
  frozenWorkflow(
    refClosureJson: string | null,
    name: string,
    source: ChildCallEdgeSource,
  ): ChildCallFrozenWorkflow | null
  frozenWorkgroup(
    refClosureJson: string | null,
    name: string,
    source: ChildCallEdgeSource,
  ): ChildCallFrozenWorkgroup | null
  childClosureSubset(
    refClosureJson: string | null,
    childDefinition: WorkflowDefinition,
    childWorkflowId: string,
  ): string | null
}

export interface ChildCallSlotHold {
  /** Transfer the pre-insert hold onto the inserted child task id. */
  bind(childTaskId: string): void
  /** Drop the hold without a task row (launch failed before insert). */
  release(): void
}

/** Invocation depth ceiling and the daemon-wide child-task budget. */
export interface ChildCallBudgetPort {
  maxInvocationDepth(): number
  ensureBudget(): Promise<{
    acquire(
      ancestors: readonly string[],
      opts: { signal?: AbortSignal },
    ): Promise<ChildCallSlotHold>
  }>
  parentTaskId(taskId: string): Promise<string | null>
  registerKnownChildTask(childTaskId: string): void
}

export type ChildCallActor = ChildWorkflowLaunchRequest['actor']
type TaskLevelLaunchFields = 'runtime' | 'schedulerDriver'
/** The node assembles the request; the binding adds the task-level inherited runtime and driver. */
export type ChildCallWorkflowLaunch = Omit<ChildWorkflowLaunchRequest, TaskLevelLaunchFields>
export type ChildCallWorkgroupLaunch = Omit<ChildWorkgroupLaunchRequest, TaskLevelLaunchFields>

export interface ChildCallStatus {
  readonly status: TaskStatus
  readonly errorSummary: string | null
}
export type ChildCallTerminalWatch =
  | { readonly kind: 'terminal'; readonly status: TaskStatus }
  | { readonly kind: 'missing' }
  | { readonly kind: 'aborted' }
export interface ChildCallOutcome {
  readonly status: TaskStatus
  readonly outputs: Readonly<
    Record<
      string,
      {
        readonly content: string
        readonly kind: string | null
        readonly archiveJson?: string | null
        readonly active?: boolean
      }
    >
  >
  readonly error?: { readonly summary: string | null; readonly message: string | null }
}

/** Child task lifecycle as seen from the parent call node. */
export interface ChildCallLifecyclePort {
  newChildTaskId(): string
  /** Delegated owner actor for a new child; null when the owner cannot start one. */
  resolveActor(
    kind: 'call-workflow' | 'call-workgroup',
    parentNodeRunId: string,
  ): Promise<ChildCallActor | null>
  launchWorkflow(request: ChildCallWorkflowLaunch): Promise<void>
  launchWorkgroup(request: ChildCallWorkgroupLaunch): Promise<void>
  /** Continue an existing child (RFC-285 B3 Q6: no owner rebuild or re-check). */
  resumeChild(childTaskId: string): Promise<void>
  /** Cascade the parent's cancel into the child; errors propagate unchanged. */
  cancelChild(childTaskId: string): Promise<void>
  isTaskActive(childTaskId: string): boolean
  findStatus(childTaskId: string): Promise<ChildCallStatus | null>
  watchTerminal(
    childTaskId: string,
    opts: { signal?: AbortSignal; pollMs: number },
  ): Promise<ChildCallTerminalWatch>
  outcome(childTaskId: string): Promise<ChildCallOutcome>
}

export interface ChildCallWorkspacePort extends Pick<
  ScriptWorkspacePort,
  | 'createIsoUnderLock'
  | 'persistIsoBase'
  | 'mergeBackAndSettle'
  | 'markMergeFailed'
  | 'discardNodeIso'
> {
  /** Rebuild an adopted call row's iso from its persisted columns (replay idiom). */
  restoreIso(input: {
    nodeRunId: string
    workspaceRef: string | null
    baseSnapshots: Record<string, string>
    checkpoints: readonly TaskRepositoryCheckpoint[]
  }): Promise<IsoHandle>
}

export interface ChildCallNodeExecutionPorts {
  readonly task: ChildCallTaskFacts
  readonly policy: { readonly signal: AbortSignal | undefined }
  readonly log: Logger
  readonly input: ScriptInputPort & {
    copyPortArchive(archiveJson: string | null): string | null
  }
  readonly ledger: Pick<
    ScriptRunLedger,
    | 'listNodeRuns'
    | 'resolveSchedulerRunRow'
    | 'setNodeRunStatus'
    | 'transitionNodeRunStatus'
    | 'upsertOutputs'
  > & {
    read: NodeExecutionPersistence['read']
    patch(input: WithoutContext<Parameters<NodeExecutionPersistence['patch']>[0]>): Promise<boolean>
  }
  readonly closure: ChildCallClosurePort
  readonly budget: ChildCallBudgetPort
  readonly children: ChildCallLifecyclePort
  readonly workspace: ChildCallWorkspacePort
  readonly conflicts: MergeConflictResolver
  readonly status: NodeStatusEvents
}
