import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { Logger } from './executionKernel'
import type { NodeExecutionPersistence } from './nodeExecutionPersistence'
import type { NodeRunLifecyclePersistence } from './nodeRunLifecyclePersistence'
import type { RunSelectionReader } from './runSelection'
import type { TaskExecutionIntentPersistence } from './taskExecutionIntentPersistence'
import type { TaskExecutionContextRef } from './taskExecutionTopology'

/** RFC-409 — one scope invocation: the wrapper that owns it (null at the root) and its frame. */
export interface DagScopeArgs {
  readonly scopeId: string | null
  readonly scopeIds: Set<string>
  /** RFC-354 — the wrapper generation row whose body is being driven; null at the workflow root. */
  readonly containerRunId: string | null
  readonly iteration: number
  readonly log: Logger
}

/** RFC-409 — what one dispatched node settles to, as the scope loop consumes it. */
export interface DagNodeOutcome {
  readonly kind: 'ok' | 'failed' | 'canceled' | 'awaiting_review' | 'awaiting_human'
  readonly summary: string
  readonly message: string
  readonly processUnreaped?: true
}

/**
 * RFC-409 — capabilities of the DAG scope interpreter (`engine/scope/runScope.ts`). Every value is read
 * when the scope asks for it; node execution, auto commit&push and the collaboration projection are
 * bound in composition.
 */
export interface DagScopePorts {
  readonly task: {
    readonly taskId: string
    /** The task row id the commit&push history is selected by. */
    readonly rowId: string
    readonly definition: WorkflowDefinition
    readonly autoCommitPush: boolean
    readonly topLevelIds: ReadonlySet<string>
    readonly containerOf: ReadonlyMap<string, string>
  }
  readonly execution: TaskExecutionContextRef | undefined
  readonly signal: AbortSignal | undefined
  readonly persistence: {
    readonly selection: Pick<RunSelectionReader, 'familyHistory' | 'currentInFrame'>
    readonly nodeExecution: Pick<NodeExecutionPersistence, 'list'>
    readonly nodeRuns: Pick<NodeRunLifecyclePersistence, 'transition'>
    readonly intents: Pick<TaskExecutionIntentPersistence, 'hasPendingGateSuccessor'>
  }
  /** The collaboration-owned scheduler projection (deferred questions, open clarify, park targets). */
  readonly collaboration: {
    autoDispatchDeferredQuestions(taskId: string): Promise<void>
    loadOpenClarifyEvidence(taskId: string): Promise<{
      readonly clarifyNodeIds: ReadonlySet<string>
      readonly askingRunIds: ReadonlySet<string>
    }>
    loadUndispatchedParkTargets(taskId: string): Promise<ReadonlySet<string>>
  }
  executeNode(input: {
    readonly node: WorkflowNode
    readonly containerRunId: string | null
    readonly iteration: number
    readonly log: Logger
  }): Promise<DagNodeOutcome>
  /** RFC-075 auto commit&push after a top-level node completes. */
  commitPush(
    node: WorkflowNode,
    iteration: number,
    log: Logger,
  ): Promise<{ processUnreaped?: true }>
}
