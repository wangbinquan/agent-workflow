import type {
  Agent,
  ClarifyDirective,
  MergeStateTransitionEvent,
  ResourceRefAst,
  ReviewPromptContext,
  TriggerContext,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'
import type { TaskAgentResourceMaterial } from '@/modules/resource-catalog/public/participants'
import type {
  TaskExecutionAgentSnapshot,
  TaskExecutionMcpSnapshot,
} from '@/modules/resource-catalog/public/types'
import type { TaskAgentRuntimeBindings } from '@/modules/runtime-management/public/participants'
import type { IsoHandle, MergeBackConflict } from '@/platform/contracts/isolationWorkspace'
import type { Semaphore } from '@/platform/contracts/semaphore'
import type * as agentRunHistory from '../agentRunHistory'
import type { PortValidationFailure } from '../portOutputValidation'
import type { AgentRunSettledObserver } from './agentRunSettledObserver'
import type { AgentClarifyGateReceipt, AgentClarifyGateRequest } from './collaborationNodeGate'
import type { Logger } from './executionKernel'
import type { MergeConflictResolver } from './mergeConflictResolution'
import type { NodeExecutionPersistence } from './nodeExecutionPersistence'
import type { ExecutionDiagnostics, NodeStatusEvents } from './nodeExecutionSupport'
import type { ScriptInputPort, ScriptRunLedger } from './scriptNodeExecution'
import type { RunResult, TaskAgentRunPolicy } from './taskAgentRun'
import type { TaskAgentRunScope } from './taskAgentRunFamily'

// RFC-405 / RFC-406 — explicit capabilities of the agent-single executor's two lanes (the DAG body and
// the workgroup host). Every value is read when a body asks for it; nothing is frozen when the gateway
// is built.

type WithoutContext<T> = Omit<T, 'executionContext'>
/** A run-history read with the current persistence already bound. */
type BoundHistory<F> = F extends (
  persistence: NodeExecutionPersistence,
  ...rest: infer A
) => infer R
  ? (...rest: A) => R
  : never

/** Task facts the agent body reads (getters bound to the running task). */
export interface AgentTaskFacts {
  readonly taskId: string
  readonly definition: WorkflowDefinition
  readonly triggerContext: TriggerContext | null
  readonly repoPath: string
  readonly baseBranch: string
  readonly worktreePath: string
  readonly gitUserName: string | null
  readonly gitUserEmail: string | null
  readonly platformInputPathsJson: string | null
  /** RFC-248 / RFC-406: canonical repositories' mount paths, in task order (host templates render these). */
  readonly repoMounts: readonly string[]
}

export interface AgentExecutionPolicy {
  readonly appHome: string
  readonly defaultPerNodeTimeoutMs?: number
  readonly defaultNodeRetries?: number
  readonly sessionRestartBudget?: number
  readonly defaultRuntime?: string
}

/**
 * The collaboration capabilities the agent body uses, owned by task-execution: the binding hands in the
 * collaboration runtime, so the compiler checks it satisfies these signatures. `openAgentClarify`
 * takes the required gate port's request; the binding adds the current execution context.
 */
export interface AgentCollaborationPort {
  resolveBorrowForNode(input: {
    readonly taskId: string
    readonly nodeId: string
    readonly iteration: number
    readonly definition: WorkflowDefinition
  }): Promise<string | null>
  buildReviewPromptContext(input: {
    readonly appHome: string
    readonly upstreamNodeId: string
    readonly taskId: string
    readonly iteration: number
  }): Promise<ReviewPromptContext | undefined>
  getNodeClarifyDirective(input: {
    readonly taskId: string
    readonly nodeId: string
    readonly shardKey?: string | null
  }): Promise<ClarifyDirective | undefined>
  buildClarifyQueueContext(input: {
    readonly definition: WorkflowDefinition
    readonly taskId: string
    readonly consumerNodeId: string
    readonly dispatchedRunId: string
    readonly shardKey?: string | null
    readonly iteration: number
    readonly envelopeNonce?: string
    readonly currentRunOnly?: boolean
  }): Promise<{ readonly block: string; readonly sourceRunIds: readonly string[] } | undefined>
  openAgentClarify(request: AgentClarifyGateRequest): Promise<AgentClarifyGateReceipt>
  /** RFC-181 C / RFC-406: the workgroup host's live ask-back suppression read. */
  isTaskClarifySuppressed(input: {
    readonly taskId: string
    readonly nodeId?: string
    readonly shardKey?: string | null
  }): Promise<boolean>
  /** RFC-181 C / RFC-406: dismiss open ask-back parks once the task turned autonomous. */
  dismissOpenClarifyParksForAutonomous(input: {
    readonly taskId: string
    readonly mode?: string
  }): Promise<{ readonly dismissedSessions: number }>
}

/**
 * Pure clarify / session / envelope rules the body applies. Their implementations still live in
 * `services/` and `@agent-workflow/shared`; the binding hands them in, so the compiler checks they
 * satisfy these signatures without this contract depending on the legacy layer.
 */
export interface AgentRules {
  agentRefOfNode(node: { readonly agentId?: unknown }): ResourceRefAst | null
  findClarifyNode(definition: WorkflowDefinition, clarifyNodeId: string): WorkflowNode | undefined
  computeRemaining(
    definition: WorkflowDefinition,
    consumerNodeId: string,
    targetIteration: number,
  ): string
  resolveEffectiveClarifyChannel(args: {
    readonly hasClarifyChannel: boolean
    readonly contextDirective?: ClarifyDirective
    readonly nodeStopOverride: boolean
    readonly reviewActive: boolean
    readonly isClarifyRerun: boolean
  }): boolean
  shouldInjectStopNotice(args: {
    readonly nodeStopOverride: boolean
    readonly contextDirective?: ClarifyDirective
  }): boolean
  parsePortValidationFailuresJson(raw: string | null): PortValidationFailure[] | null
  isClarifyRerunCause(cause: string | null | undefined): boolean
  continuesClarifyLineage(causesNewestFirst: ReadonlyArray<string | null | undefined>): boolean
  /** The error-message prefix of a suppressed ask-back (`services/envelope`). */
  readonly clarifyForbiddenPrefix: string
  decideResumeSessionId(input: {
    readonly sessionMode: 'isolated' | 'inline'
    readonly sourceSessionId: string | null | undefined
    readonly supportsSessionResume?: boolean
  }): {
    readonly resumeSessionId?: string
    readonly fallbackReason?: agentRunHistory.ClarifyInlineFallbackReason
    readonly inlineMode: boolean
  }
}

/** RFC-345 T4a — the agent's frozen resource injection: catalog snapshots plus owner-bound material. */
export type AgentInjection =
  | {
      readonly kind: 'ok'
      readonly spec: {
        readonly agent: TaskExecutionAgentSnapshot
        readonly dependents: readonly TaskExecutionAgentSnapshot[]
        readonly mcps: readonly TaskExecutionMcpSnapshot[]
        readonly material: TaskAgentResourceMaterial
      }
      readonly notices: readonly []
    }
  | { readonly kind: 'failed'; readonly summary: string; readonly message: string }

export interface AgentResources {
  injection(agentId: string): Promise<AgentInjection>
  /** RFC-406: the workgroup host's injection — the orchestrator is synthetic, every other agent comes from the session. */
  hostInjection(agent: Agent): Promise<AgentInjection>
}

export interface AgentRunHistoryPort {
  countAgentTextEvents: BoundHistory<typeof agentRunHistory.countAgentTextEvents>
  priorDoneGenerationsForRun: BoundHistory<typeof agentRunHistory.priorDoneGenerationsForRun>
  lineageCausesNewestFirst: BoundHistory<typeof agentRunHistory.lineageCausesNewestFirst>
  readPriorAgentSessionId: BoundHistory<typeof agentRunHistory.readPriorAgentSessionId>
  freshestPriorRunWithOutput: BoundHistory<typeof agentRunHistory.freshestPriorRunWithOutput>
  composePriorOutputBlock: BoundHistory<typeof agentRunHistory.composePriorOutputBlock>
  readStderrText: BoundHistory<typeof agentRunHistory.readStderrText>
  recordClarifyInlineEvent: BoundHistory<typeof agentRunHistory.recordClarifyInlineEvent>
}

/** Task-level run fields the binding supplies; the body assembles everything else. */
type TaskLevelRunFields =
  | 'persistence'
  | 'observationInvocations'
  | 'runtimeRegistry'
  | 'runtimeSessionLeases'
  | 'signal'
  | 'memorySnapshots'
  | 'memoryInjectionQueries'
  | 'subagentLiveCapture'
export type AgentRunRequest = Omit<TaskAgentRunPolicy, TaskLevelRunFields>
export type AgentRunLaunch = Omit<TaskAgentRunScope, 'taskId' | 'nodeRunId' | 'taskMountRefs'>

type FrozenAgentRuntime = Awaited<ReturnType<TaskAgentRuntimeBindings['resolve']>>
export interface AgentRuntimePort {
  ofSession: TaskAgentRuntimeBindings['ofSession']
  resolve: TaskAgentRuntimeBindings['resolve']
  runAgent(request: AgentRunRequest, launch: AgentRunLaunch): Promise<RunResult>
  /** The selected runtime driver's own session-not-found detector; undefined when it has none. */
  detectSessionNotFound(
    protocol: FrozenAgentRuntime['protocol'],
    stderr: string,
  ): boolean | undefined
}

export interface AgentWorkspacePort {
  createIsoUnderLock(isoKeyRunId: string): Promise<IsoHandle>
  persistIsoBase(nodeRunId: string, handle: IsoHandle): Promise<void>
  mergeBackAndSettle(input: {
    handle: IsoHandle
    nodeRunId: string
    via: 'live'
    extraForcedContainerPaths?: string[]
    conflictResolver(
      conflicts: MergeBackConflict[],
      containerPath: string,
    ): Promise<{ allResolved: boolean; detail: string }>
  }): Promise<{ kind: 'merged' | 'conflict-human'; detail?: string }>
  markMergeFailed(nodeRunId: string, message: string): Promise<void>
  /** RFC-167 / RFC-187 T8: close this run's merge state as abandoned (its delta never reaches canonical). */
  abandonMerge(
    nodeRunId: string,
    reason: Extract<MergeStateTransitionEvent, { kind: 'abandon' }>['reason'],
  ): Promise<boolean>
  discardNodeIso(handle: IsoHandle): Promise<void>
  /** RFC-193 K1: this run's own port files, relative to the port fallback mount. */
  portFileContainerPaths(portFilePaths: readonly string[]): string[]
}

export interface AgentNodeExecutionPorts {
  readonly task: AgentTaskFacts
  readonly policy: AgentExecutionPolicy
  readonly log: Logger
  readonly agentSem: Semaphore
  readonly resources: AgentResources
  readonly collaboration: AgentCollaborationPort
  readonly rules: AgentRules
  readonly input: ScriptInputPort
  readonly ledger: Pick<
    ScriptRunLedger,
    | 'listNodeRuns'
    | 'resolveSchedulerRunRow'
    | 'mintNodeRun'
    | 'setNodeRunStatus'
    | 'transitionNodeRunStatus'
    | 'loadEnvelopeNonce'
    | 'appendEvent'
  > & {
    read: NodeExecutionPersistence['read']
    patch(input: WithoutContext<Parameters<NodeExecutionPersistence['patch']>[0]>): Promise<boolean>
  }
  readonly history: AgentRunHistoryPort
  readonly runtime: AgentRuntimePort
  readonly workspace: AgentWorkspacePort
  readonly observer: AgentRunSettledObserver
  readonly status: NodeStatusEvents
  readonly diagnostics: ExecutionDiagnostics
  readonly conflicts: MergeConflictResolver
}
