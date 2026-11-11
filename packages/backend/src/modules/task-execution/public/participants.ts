import type { NodeRunStatus } from '@agent-workflow/shared'
import type {
  HumanGateNodeRunMintRequest,
  HumanGateNodeRunSetRequest,
  HumanGateNodeRunTransitionRequest,
  HumanGateTaskNodeStatusesRequest,
  HumanGateTaskTransitionRequest,
  HumanGateTaskTransitionResult,
} from '../application/ports/humanGateTaskParticipants'
import type { TaskExecutionPostCommitEventRef } from '../domain/postCommitEventRef'
export type {
  HumanGateNodeRunMintRequest,
  HumanGateNodeRunSetRequest,
  HumanGateNodeRunTransitionRequest,
  HumanGateTaskNodeStatusesRequest,
  HumanGateTaskTransitionRequest,
  HumanGateTaskTransitionResult,
} from '../application/ports/humanGateTaskParticipants'
export type { TaskExecutionPostCommitEventRef } from '../domain/postCommitEventRef'

export { selectPortArtifactReader } from '../composition/portArtifacts'
// RFC-370: provider drive bindings belong to composition; bootstrap imports them there.
// RFC-303 — the only cross-context task-control surface.
// It deliberately accepts a source binding, never caller-selected task ids.
import type { DurableCodeHostEffectObserver } from '../application/codeHostEffectObserver'
import {
  fenceTaskWrite as fenceTaskWriteInternal,
  withTaskExecutionWrite as withTaskExecutionWriteInternal,
} from '../composition/ownedTaskMutation'
// RFC-370 hosted acceptance: the ambient lookup is the provider-neutral one.
// The SQLite compatibility wrapper hides every context without its legacy
// connection — that is every PostgreSQL daemon context — so a gate opened from
// the ambient context fenced as an ownerless write and the task's own claimed
// owner refused it.
import type {
  AcceptHumanGateDecisionInput,
  AcceptedHumanGateDecision,
} from '../application/acceptHumanGateDecision'
import { createGateContinuationDriver as createGateContinuationDriverInternal } from '../application/drive/gateContinuationDriver'
import type { RecoverableTerminalMaintenanceClaim } from '../application/ports/terminalMaintenanceStore'
import { currentTaskExecutionContext as currentTaskExecutionContextInternal } from '../application/taskExecutionContext'
import { composeWorktreeResumePreflight as composeWorktreeResumePreflightInternal } from '../application/worktreeResumePreflight'
import {
  buildCodeHostRecoveryDescriptor as buildCodeHostRecoveryDescriptorInternal,
  classifyCodeHostProbeResponse as classifyCodeHostProbeResponseInternal,
  codeHostRecoveryBaseUrlDigest as codeHostRecoveryBaseUrlDigestInternal,
  type CodeHostProbeOutcome,
  type CodeHostRecoveryDescriptor,
} from '../domain/codeHostRecovery'
import {
  humanGateNodeProjectionFence as humanGateNodeProjectionFenceInternal,
  isLegacyTaskGateContinuationPayload as isLegacyTaskGateContinuationPayloadInternal,
  type HumanGateContinuationLineage,
  type HumanGateNodeProjectionFence,
  type HumanGateWorkspaceRollbackRef,
} from '../domain/humanGateContinuation'
import type {
  MaintenanceMemberSnapshot,
  TerminalMaintenanceState,
} from '../domain/terminalMaintenance'
// RFC-359：bun:sqlite 专属的三个**同步**参与者（`appendTask{Created,LifecycleTransition,
// NodeStatuses}CommittedEventTx`）随最后一个同步调用方退役，`taskLifecycleEventParticipant.ts`
// 整文件删除。事件形状本来就只有一份，在 `taskLifecycleCommittedEvents.ts`；两个引擎共用的中立
// 异步形态从这里出去。
// RFC-359 —— 下面三个是上面那批同步原子的**中立异步孪生**（`PersistenceTx` 上的形态）。
// 生命周期写事务从 bun:sqlite 专属同步面搬走之后，`onTransitionTx` 回调里的参与者都要用这一侧。

declare const ownershipTokenBrand: unique symbol
declare const maintenanceClaimBrand: unique symbol

export type {
  SourceTerminationEffectCapability,
  TaskSourceTerminationEffectInput,
  TaskSourceTerminationParticipant,
} from '../application/applySourceTerminationEffect'

// RFC-328 — capability identities are owned by this participant entrypoint.
// Constructors remain module-internal; legacy callers only receive the opaque
// values after the task-execution composition root has performed the durable
// claim or maintenance transaction.
export interface OwnershipToken {
  readonly taskId: string
  readonly ownerId: string
  readonly daemonGeneration: string
  readonly epoch: number
  readonly leaseUntil: number
  readonly ownerRevision: number
  readonly [ownershipTokenBrand]: true
}

export type TerminalMaintenanceOperation =
  | 'archive'
  | 'delete'
  | 'retention'
  | 'workspace-gc'
  | 'repair-metadata'

export interface TerminalMaintenanceClaim {
  readonly claimId: string
  readonly operation: TerminalMaintenanceOperation
  readonly revision: number
  readonly memberSetDigest: string
  readonly [maintenanceClaimBrand]: true
}

export type {
  AcceptHumanGateDecisionInput,
  AcceptedHumanGateDecision,
  CodeHostProbeOutcome,
  CodeHostRecoveryDescriptor,
  HumanGateContinuationLineage,
  HumanGateNodeProjectionFence,
  HumanGateWorkspaceRollbackRef,
  MaintenanceMemberSnapshot,
  RecoverableTerminalMaintenanceClaim,
  TerminalMaintenanceState,
}

export type {
  AsyncTaskAuthorizationParticipantInTx,
  TaskActingMembershipInput,
  TaskAuthorizationLookupInput,
  TaskAuthorizationQueries,
  TaskAuthorizationSubject,
  VisibleTaskIdsInput,
} from '../application/ports/taskAuthorization'

declare const taskNodeStatusEventsParticipantBrand: unique symbol
declare const humanGateNodeRunStateParticipantBrand: unique symbol
declare const taskDecisionParticipantBrand: unique symbol
declare const humanGateNodeRunMintParticipantBrand: unique symbol
declare const humanGateTaskTransitionParticipantBrand: unique symbol

export interface TaskNodeStatusEventsParticipantInTx {
  readonly [taskNodeStatusEventsParticipantBrand]: true
  append(input: HumanGateTaskNodeStatusesRequest): Promise<TaskExecutionPostCommitEventRef | null>
}

// Member names match the task-execution node-run CAS kernel (`setNodeRunStatusTx` /
// `transitionNodeRunStatusTx`): the RFC-317 transition-table oracle recognises CAS
// sites by callee name, so a generic `set` would hide collaboration's sites from it.
export interface HumanGateNodeRunStateParticipantInTx {
  readonly [humanGateNodeRunStateParticipantBrand]: true
  setNodeRunStatus(
    input: HumanGateNodeRunSetRequest,
  ): Promise<{ readonly from: NodeRunStatus; readonly to: NodeRunStatus }>
  transitionNodeRunStatus(
    input: HumanGateNodeRunTransitionRequest,
  ): Promise<{ readonly from: NodeRunStatus; readonly to: NodeRunStatus }>
}

export interface TaskDecisionParticipantInTx {
  readonly [taskDecisionParticipantBrand]: true
  acceptGateDecisionTx(input: AcceptHumanGateDecisionInput): Promise<AcceptedHumanGateDecision>
}

export interface HumanGateNodeRunMintParticipantInTx {
  readonly [humanGateNodeRunMintParticipantBrand]: true
  mint(input: HumanGateNodeRunMintRequest): Promise<string>
}

export interface HumanGateTaskTransitionParticipantInTx {
  readonly [humanGateTaskTransitionParticipantBrand]: true
  transition(input: HumanGateTaskTransitionRequest): Promise<HumanGateTaskTransitionResult>
}

/** This operation owns its write transaction; it is never an InTx participant. */
export interface HumanGateNodeRunMintOperations {
  mint(input: HumanGateNodeRunMintRequest): Promise<string>
}

export interface CodeHostSendAttemptInfo {
  readonly candidateId: string
  readonly transportAttempt: number
  readonly method: string
  readonly pathname: string
  readonly recoveryDescriptor: CodeHostRecoveryDescriptor
}

export type CodeHostSendAttemptObserver = DurableCodeHostEffectObserver

// Exact provider-facing adapters used while the legacy orchestration files are
// being moved behind RFC-294 W2. Constructors and stores stay owned by this
// context; production calls remain constrained by RFC-328's exact source
// allowlists.
export const currentTaskExecutionContext = currentTaskExecutionContextInternal
export const fenceTaskWrite = fenceTaskWriteInternal
export const withTaskExecutionWrite = withTaskExecutionWriteInternal
// Composition supplies only the exact lifecycle transition participant. The
// public task-execution surface does not close over the legacy lifecycle
// adapter, so lifecycle.ts can consume the remaining participant aggregate
// without creating a value cycle.
export const humanGateNodeProjectionFence = humanGateNodeProjectionFenceInternal
export const isLegacyTaskGateContinuationPayload = isLegacyTaskGateContinuationPayloadInternal
export const buildCodeHostRecoveryDescriptor = buildCodeHostRecoveryDescriptorInternal
export const classifyCodeHostProbeResponse = classifyCodeHostProbeResponseInternal
export const codeHostRecoveryBaseUrlDigest = codeHostRecoveryBaseUrlDigestInternal
export const composeWorktreeResumePreflight = composeWorktreeResumePreflightInternal
/** RFC-370 — the daemon worker's entry into an admitted human-gate continuation. */
export const createGateContinuationDriver = createGateContinuationDriverInternal
export type {
  GateWorkspaceRollbackExecutor,
  GateWorkspaceRollbackOutcome,
  GateWorkspaceRollbackPlanView,
  GateWorkspaceRollbackReceipt,
  GateWorkspaceRollbackRef,
  GateWorkspaceRollbackTargetReceipt,
} from '../application/ports/gateWorkspaceRollback'

// RFC-359 AC-1 的进程内活跃度参与者端口（`ActiveTaskExecutionParticipant`）此前从这里出去，只因 legacy 的
// `services/taskDelete.ts` 不得 import 模块内部；RFC-476 后删除实现在 task-execution 内，直接取定义处。

export type { TaskExecutionPermits } from '../application/ports/taskExecutionPermits'

/** The execution demand owns the joint invocation consumed by system runs. */
export type { SystemAgentObservationRun } from '../application/ports/systemAgentObservation'
export type { PreparedSystemAgentRunResult } from '../application/ports/systemAgentRun'
export type {
  SystemAgentRunFamily,
  SystemAgentRunRequest,
} from '../application/ports/systemAgentRunFamily'
export { classifyMissingEnvelope } from '../application/systemAgentRun'

/** RFC-370 v3 V5: Task Execution's hosted restore normalization participant. */
export { createHostedRestoreTaskNormalization } from '../infrastructure/hostedRestoreNormalization'

export type {
  ConsumedInputsParticipantInTx,
  ConsumedInputsWrite,
} from '../application/ports/consumedInputs'
export { prepareConsumedInputs } from '../infrastructure/consumedInputsParticipant'

// RFC-482: the consumed-inputs and human-gate persistence participants and the clarify-directive persistence reach
// collaboration as factory references through its participant bindings (bootstrap hands them over from composition);
// only their interfaces are public. The no-op `reselectRunInTx` is gone.
export type { HumanGatePersistenceParticipantInTx } from '../application/ports/humanGatePersistenceParticipant'

export type { TaskClarifyDirectivePersistence } from '../application/ports/taskClarifyDirectivePersistence'

// RFC-478：`createTaskPreparationParticipantInTx` 撤出后，它的返回类型 `TaskPreparationParticipant` 也一并撤出。

// RFC-476 —— 评审写入与任务取消共用的进程内每任务 FIFO（原 `services/reviewMutationCoordinator.ts`）归 task-execution；
// collaboration 的评审与协作者写入经这个闭合接口参与方进同一个队列（评审作用域解析与找不到的错误留在 collaboration）。
export { taskReviewMutationQueue } from '../infrastructure/reviewMutationQueue'
