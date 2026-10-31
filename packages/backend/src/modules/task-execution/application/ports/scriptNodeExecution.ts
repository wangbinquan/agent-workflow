import type {
  NodeRunStatus,
  ScriptFailureCode,
  ScriptLanguage,
  WorkflowNode,
} from '@agent-workflow/shared'
import type { IsoHandle, MergeBackConflict } from '@/platform/contracts/isolationWorkspace'
import type { NodeExecutionPersistence, NodeExecutionSnapshot } from './nodeExecutionPersistence'
import type {
  ResolveSchedulerRunRowInput,
  ResolvedSchedulerRunRow,
} from '../resolveSchedulerRunRow'
import type { ProcessEffectAttemptObserver } from '../processEffectObserver'
import type { NodeRunLedger, NodeRunIdentityFactory, Logger } from './executionKernel'
import type { MergeStateLifecyclePersistence } from './mergeStateLifecyclePersistence'
import type { MergeConflictResolver } from './mergeConflictResolution'
import type {
  TaskScriptRunFamily,
  TaskScriptStartProjection,
  TaskScriptEffectResources,
  TaskScriptStartReceipt,
  TaskScriptResult,
} from './taskScriptRunFamily'

type WithoutContext<T> = Omit<T, 'executionContext'>
export interface ScriptExecutionPolicy {
  readonly appHome: string
  readonly defaultNodeRetries?: number
  readonly defaultPerNodeTimeoutMs?: number
  readonly scriptDepsInstallTimeoutMs?: number
  readonly scriptInterpreters?: Partial<Record<ScriptLanguage, string>>
}
export interface ScriptTaskFacts {
  readonly taskId: string
  readonly gitUserName: string | null
  readonly gitUserEmail: string | null
  readonly scopeRoot: string
  readonly repos: readonly { readonly mountPath: string; readonly worktreePath: string }[]
}
export interface ScriptInputPort {
  resolveUpstreamInputs(
    nodeId: string,
    frame: { containerRunId: string | null; iteration: number },
  ): Promise<{
    inputs: Record<string, string>
    consumed: Record<string, string>
  }>
  prepareConsumedInputs(record: Record<string, string>): string
}
export interface ScriptRunLedger extends NodeRunLedger, NodeRunIdentityFactory {
  listNodeRuns(
    input: Parameters<NodeExecutionPersistence['list']>[0],
  ): Promise<readonly NodeExecutionSnapshot[]>
  resolveSchedulerRunRow(
    input: Omit<
      ResolveSchedulerRunRowInput<NodeExecutionSnapshot>,
      'lifecycle' | 'projections' | 'selection' | 'executionContext'
    >,
  ): Promise<ResolvedSchedulerRunRow<NodeExecutionSnapshot>>
  appendEvent(
    input: WithoutContext<Parameters<NodeExecutionPersistence['appendEvent']>[0]>,
  ): Promise<void>
  upsertOutputs(
    input: WithoutContext<Parameters<NodeExecutionPersistence['upsertOutputs']>[0]>,
  ): Promise<void>
}
export interface ScriptWorkspacePort {
  createIsoUnderLock(isoKeyRunId: string): Promise<IsoHandle>
  persistIsoBase(nodeRunId: string, handle: IsoHandle): Promise<void>
  mergeBackAndSettle(input: {
    handle: IsoHandle
    nodeRunId: string
    via: 'live' | 'replay'
    conflictResolver(
      conflicts: MergeBackConflict[],
      containerPath: string,
    ): Promise<{ allResolved: boolean; detail: string }>
  }): Promise<{ kind: 'merged' | 'conflict-human'; detail?: string }>
  markMergeFailed(nodeRunId: string, message: string): Promise<void>
  discardNodeIso(handle: IsoHandle): Promise<void>
  transitionMergeState(
    input: WithoutContext<Parameters<MergeStateLifecyclePersistence['transition']>[0]>,
  ): ReturnType<MergeStateLifecyclePersistence['transition']>
}
export interface ScriptProcessPort extends Pick<
  TaskScriptRunFamily,
  | 'resolveInterpreter'
  | 'describeInterpreterResolution'
  | 'prepareRunContent'
  | 'dependencyInterpreter'
  | 'ensureDependencies'
  | 'runtimeParameters'
> {
  runScriptProcess(
    input: Parameters<TaskScriptRunFamily['execute']>[0],
  ): ReturnType<TaskScriptRunFamily['execute']>
  recordUnownedStart(
    input: Omit<
      Parameters<TaskScriptRunFamily['recordUnownedStart']>[0],
      'persistence' | 'executionContext'
    >,
  ): Promise<void>
}
export type ScriptProcessEffect = ProcessEffectAttemptObserver<
  TaskScriptStartReceipt,
  TaskScriptResult
>
export interface ScriptEffectPort {
  createProcessEffectAttemptObserver(input: {
    taskId: string
    nodeRunId: string
    start: TaskScriptStartProjection
    resources: TaskScriptEffectResources
  }): ScriptProcessEffect | undefined
}
export interface ScriptOutputPort {
  extractScriptPorts(input: {
    node: WorkflowNode
    rawStdout: string
    nonce: string
  }):
    | { kind: 'ok'; ports: Record<string, string>; inactivePorts: string[] }
    | { kind: 'failed'; code: ScriptFailureCode; detail: string }
}
export interface NodeStatusEvents {
  broadcastNodeStatus(
    taskId: string,
    nodeRunId: string,
    nodeId: string,
    status: NodeRunStatus,
  ): void
}
export interface ExecutionDiagnostics {
  describeIsoFailure(code: string, error: unknown): string
}
export interface ScriptNodeExecutionPorts {
  readonly policy: ScriptExecutionPolicy
  readonly task: ScriptTaskFacts
  readonly log: Logger
  readonly scriptSem: { acquire(): Promise<() => void> }
  readonly input: ScriptInputPort
  readonly ledger: ScriptRunLedger
  readonly workspace: ScriptWorkspacePort
  readonly process: ScriptProcessPort
  readonly effect: ScriptEffectPort
  readonly output: ScriptOutputPort
  readonly status: NodeStatusEvents
  readonly diagnostics: ExecutionDiagnostics
  readonly conflicts: MergeConflictResolver
}
