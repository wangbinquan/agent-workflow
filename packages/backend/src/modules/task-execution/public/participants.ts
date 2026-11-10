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

export { selectNodeRunPromptOperations } from '../composition/nodeRunPrompts'
export {
  selectPortArtifactOperations,
  selectPortArtifactReader,
} from '../composition/portArtifacts'
// RFC-370: provider drive bindings belong to composition; bootstrap imports them there.
// RFC-303 — the only cross-context task-control surface.
// It deliberately accepts a source binding, never caller-selected task ids.
import type {
  CodeHostEffectObserverHandle,
  DurableCodeHostEffectObserver,
} from '../application/codeHostEffectObserver'
import { createCodeHostEffectAttemptObserver as createCodeHostEffectAttemptObserverInternal } from '../application/codeHostEffectObserver'
import { createLocalEffectAttemptObserver as createLocalEffectAttemptObserverInternal } from '../application/localEffectObserver'
import {
  DEFAULT_OWNERSHIP_HEARTBEAT_MS,
  DEFAULT_OWNERSHIP_LEASE_MS,
  taskExecutionModule as taskExecutionModuleInternal,
} from '../composition'
import {
  fenceTaskWrite as fenceTaskWriteInternal,
  withTaskExecutionWrite as withTaskExecutionWriteInternal,
} from '../composition/ownedTaskMutation'
import { createProcessEffectAttemptObserver as createProcessEffectAttemptObserverInternal } from '../composition/processEffectObserver'
import {
  assertTaskExecutionContext as assertTaskExecutionContextInternal,
  createTaskExecutionContext as createTaskExecutionContextInternal,
  runWithTaskExecutionContext as runWithTaskExecutionContextInternal,
} from '../composition/sqliteTaskExecutionContext'
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
import { GateContinuationEffectStep as GateContinuationEffectStepInternal } from '../application/drive/gateContinuationEffectStep'
import type { SchedulerDriverPort } from '../application/ports/taskExecutionTopology'
import type { RecoverableTerminalMaintenanceClaim } from '../application/ports/terminalMaintenanceStore'
import { currentTaskExecutionContext as currentTaskExecutionContextInternal } from '../application/taskExecutionContext'
import { TaskExecutionError as TaskExecutionErrorInternal } from '../application/taskExecutionError'
import {
  assertWorktreePresentForResume as assertWorktreePresentForResumeInternal,
  composeWorktreeResumePreflight as composeWorktreeResumePreflightInternal,
} from '../application/worktreeResumePreflight'
import {
  buildCodeHostRecoveryDescriptor as buildCodeHostRecoveryDescriptorInternal,
  classifyCodeHostProbeResponse as classifyCodeHostProbeResponseInternal,
  codeHostRecoveryBaseUrlDigest as codeHostRecoveryBaseUrlDigestInternal,
  type CodeHostProbeOutcome,
  type CodeHostRecoveryDescriptor,
} from '../domain/codeHostRecovery'
import {
  operationFamilyKey as operationFamilyKeyInternal,
  requestHash as taskExecutionRequestHashInternal,
} from '../domain/executionEffect'
import {
  canonicalJson as canonicalTaskExecutionJsonInternal,
  decodeLineageSlotPath as decodeLineageSlotPathInternal,
  encodeLineageSlotPath as encodeLineageSlotPathInternal,
  type LineageSlot,
  type TaskExecutionIntentKind,
  type TaskExecutionIntentSource,
} from '../domain/executionIntent'
import {
  humanGateNodeProjectionFence as humanGateNodeProjectionFenceInternal,
  isLegacyTaskGateContinuationPayload as isLegacyTaskGateContinuationPayloadInternal,
  type HumanGateContinuationLineage,
  type HumanGateNodeProjectionFence,
  type HumanGateWorkspaceRollbackRef,
} from '../domain/humanGateContinuation'
import {
  createExclusiveDaemonLockProof as createExclusiveDaemonLockProofInternal,
  createVerifiedOutcomeUnknownClosure as createVerifiedOutcomeUnknownClosureInternal,
  createVerifiedStopProof as createVerifiedStopProofInternal,
  exactOwnerMatches as exactOwnerMatchesInternal,
  ownershipTokenKey as ownershipTokenKeyInternal,
} from '../domain/ownership'
import type { TaskNodeChangeV1 } from '../domain/taskLifecycleCommittedEvent'
import type {
  MaintenanceMemberSnapshot,
  TerminalMaintenanceState,
} from '../domain/terminalMaintenance'
import {
  builtinWorkflowSyncPreview as builtinWorkflowSyncPreviewInternal,
  workflowSyncGateReason as workflowSyncGateReasonInternal,
} from '../domain/workflowSyncPreview'
import { humanGateNodeProjectionMember as humanGateNodeProjectionMemberInternal } from '../infrastructure/humanGateProjection'
// RFC-359：bun:sqlite 专属的三个**同步**参与者（`appendTask{Created,LifecycleTransition,
// NodeStatuses}CommittedEventTx`）随最后一个同步调用方退役，`taskLifecycleEventParticipant.ts`
// 整文件删除。事件形状本来就只有一份，在 `taskLifecycleCommittedEvents.ts`；两个引擎共用的中立
// 异步形态从这里出去。
import { setNodeRunStatusTx as setNodeRunStatusInTransactionInternal } from '../infrastructure/nodeRunLifecycleTransition'
import {
  appendTaskCreatedCommittedEvent as appendTaskCreatedCommittedEventInternal,
  type TaskCommittedEventIdentity,
} from '../infrastructure/taskLifecycleCommittedEvents'
// RFC-359 —— 下面三个是上面那批同步原子的**中立异步孪生**（`PersistenceTx` 上的形态）。
// 生命周期写事务从 bun:sqlite 专属同步面搬走之后，`onTransitionTx` 回调里的参与者都要用这一侧。
import { submitTaskContinuation as submitTaskContinuationInTransactionInternal } from '../infrastructure/taskContinuationAdmission'
import { terminalizeTaskExecutionIntentsUncheckedInTx as terminalizeTaskExecutionIntentsInTransactionInternal } from '../infrastructure/taskExecutionIntentTerminalPersistence'
import { revokeExactOwnerInTx as revokeExactOwnerInTransactionInternal } from '../infrastructure/taskOwnershipPersistence'

declare const workerIdentityBrand: unique symbol
declare const ownershipTokenBrand: unique symbol
declare const ownedTaskTxBrand: unique symbol
declare const maintenanceClaimBrand: unique symbol

export type {
  SourceTerminationEffectCapability,
  TaskSourceTerminationEffectInput,
  TaskSourceTerminationParticipant,
  TaskSourceTerminationReceipt,
} from '../application/applySourceTerminationEffect'
export type { TaskRuntimeLifecyclePersistence } from '../application/ports/taskRuntimeLifecyclePersistence'
/** Required runtime participants; production construction has no fallback. */
export interface SchedulerRuntimeTopology {
  readonly schedulerDriver: SchedulerDriverPort
}

// RFC-328 — capability identities are owned by this participant entrypoint.
// Constructors remain module-internal; legacy callers only receive the opaque
// values after the task-execution composition root has performed the durable
// claim or maintenance transaction.
export interface WorkerIdentity {
  readonly ownerId: string
  readonly daemonGeneration: string
  readonly [workerIdentityBrand]: true
}

export interface OwnershipToken {
  readonly taskId: string
  readonly ownerId: string
  readonly daemonGeneration: string
  readonly epoch: number
  readonly leaseUntil: number
  readonly ownerRevision: number
  readonly [ownershipTokenBrand]: true
}

export interface OwnedTaskTx {
  readonly taskId: string
  readonly epoch: number
  readonly revision: number
  readonly [ownedTaskTxBrand]: true
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
  LineageSlot,
  MaintenanceMemberSnapshot,
  RecoverableTerminalMaintenanceClaim,
  TaskCommittedEventIdentity,
  TaskExecutionIntentKind,
  TaskExecutionIntentSource,
  TaskNodeChangeV1,
  TerminalMaintenanceState,
}

export type {
  AsyncTaskAuthorizationParticipantInTx,
  TaskActingMembershipInput,
  TaskAuthorizationLookupInput,
  TaskAuthorizationParticipantInTx,
  TaskAuthorizationQueries,
  TaskAuthorizationSubject,
  VisibleTaskIdsInput,
} from '../application/ports/taskAuthorization'

export type { TaskRuntimeSessionLeaseRepairOperations } from '../application/ports/runtimeSessionLeaseOperations'
export type {
  TaskBootOrphanOperations,
  TaskPeriodicRecoveryOperations,
  TaskRecoveryOperations,
} from '../application/ports/taskRecoveryOperations'

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

export type CodeHostSendAttemptHandle = CodeHostEffectObserverHandle

export interface CodeHostSendAttemptInfo {
  readonly candidateId: string
  readonly transportAttempt: number
  readonly method: string
  readonly pathname: string
  readonly recoveryDescriptor: CodeHostRecoveryDescriptor
}

export interface CodeHostSendAttemptSettlement extends CodeHostSendAttemptInfo {
  readonly result: 'response' | 'network-error'
  readonly status?: number
  readonly willRetry: boolean
  readonly retryKind: 'none' | 'transport-policy' | 'compatibility-fallback'
  readonly errorMessage?: string
}

export type CodeHostSendAttemptObserver = DurableCodeHostEffectObserver

// Exact provider-facing adapters used while the legacy orchestration files are
// being moved behind RFC-294 W2. Constructors and stores stay owned by this
// context; production calls remain constrained by RFC-328's exact source
// allowlists.
export { DEFAULT_OWNERSHIP_HEARTBEAT_MS, DEFAULT_OWNERSHIP_LEASE_MS }
export const taskExecutionModule = taskExecutionModuleInternal

// RFC-359 W7 的终态维护认领中立面（store 工厂与两个事务内参与者）此前经这里交给 legacy 的
// `services/taskDelete.ts`；RFC-476 把删除实现迁进 task-execution，它改取定义处，这几个符号随之撤出 public。
export const createCodeHostEffectAttemptObserver = createCodeHostEffectAttemptObserverInternal
export const createLocalEffectAttemptObserver = createLocalEffectAttemptObserverInternal
export const createProcessEffectAttemptObserver = createProcessEffectAttemptObserverInternal
export const assertTaskExecutionContext = assertTaskExecutionContextInternal
export const createTaskExecutionContext = createTaskExecutionContextInternal
export const currentTaskExecutionContext = currentTaskExecutionContextInternal
export const runWithTaskExecutionContext = runWithTaskExecutionContextInternal
export const fenceTaskWrite = fenceTaskWriteInternal
export const withTaskExecutionWrite = withTaskExecutionWriteInternal
// Composition supplies only the exact lifecycle transition participant. The
// public task-execution surface does not close over the legacy lifecycle
// adapter, so lifecycle.ts can consume the remaining participant aggregate
// without creating a value cycle.
export const humanGateNodeProjectionFence = humanGateNodeProjectionFenceInternal
export const humanGateNodeProjectionMember = humanGateNodeProjectionMemberInternal
export const isLegacyTaskGateContinuationPayload = isLegacyTaskGateContinuationPayloadInternal
export const buildCodeHostRecoveryDescriptor = buildCodeHostRecoveryDescriptorInternal
export const classifyCodeHostProbeResponse = classifyCodeHostProbeResponseInternal
export const codeHostRecoveryBaseUrlDigest = codeHostRecoveryBaseUrlDigestInternal
export const operationFamilyKey = operationFamilyKeyInternal
export const taskExecutionRequestHash = taskExecutionRequestHashInternal
export const canonicalTaskExecutionJson = canonicalTaskExecutionJsonInternal
export const decodeLineageSlotPath = decodeLineageSlotPathInternal
export const encodeLineageSlotPath = encodeLineageSlotPathInternal
/** RFC-359 —— 工作流同步预览的两条判据（纯投影），legacy `services/task.ts` 经此取用。 */
export const builtinWorkflowSyncPreview = builtinWorkflowSyncPreviewInternal
export const workflowSyncGateReason = workflowSyncGateReasonInternal
/**
 * RFC-359 —— 「工作树还在不在、这个任务还能不能被继续」的唯一判据，两个 provider 共用。
 * legacy `services/task.ts` 与 PostgreSQL 部署都经此取用（后者此前注入的是空操作）。
 */
export const assertWorktreePresentForResume = assertWorktreePresentForResumeInternal
export const composeWorktreeResumePreflight = composeWorktreeResumePreflightInternal
/** RFC-370 — the daemon worker's entry into an admitted human-gate continuation. */
export const createGateContinuationDriver = createGateContinuationDriverInternal
export const appendTaskCreatedCommittedEvent = appendTaskCreatedCommittedEventInternal
export const setNodeRunStatusInTransaction = setNodeRunStatusInTransactionInternal
export const revokeExactOwnerInTransaction = revokeExactOwnerInTransactionInternal
export const terminalizeTaskExecutionIntentsInTransaction =
  terminalizeTaskExecutionIntentsInTransactionInternal
export const submitTaskContinuationInTransaction = submitTaskContinuationInTransactionInternal
export const createExclusiveDaemonLockProof = createExclusiveDaemonLockProofInternal
export const createVerifiedOutcomeUnknownClosure = createVerifiedOutcomeUnknownClosureInternal
export const createVerifiedStopProof = createVerifiedStopProofInternal
export const exactOwnerMatches = exactOwnerMatchesInternal
export const ownershipTokenKey = ownershipTokenKeyInternal
export const TaskExecutionError = TaskExecutionErrorInternal
export const GateContinuationEffectStep = GateContinuationEffectStepInternal
export type {
  GateWorkspaceRollbackExecutor,
  GateWorkspaceRollbackOutcome,
  GateWorkspaceRollbackPlanView,
  GateWorkspaceRollbackReceipt,
  GateWorkspaceRollbackRef,
  GateWorkspaceRollbackTargetReceipt,
} from '../application/ports/gateWorkspaceRollback'

/** RFC-308 task-owned, path-free workspace commit capability for code tasks. */
export type TaskWorkspaceCommitPreviewResult =
  | {
      readonly ok: true
      readonly diff: string
      readonly policyDigest: string
      readonly excludedPaths: readonly string[]
    }
  | { readonly ok: false; readonly error: string }

export type TaskWorkspaceCommitPublishResult =
  | { readonly ok: true; readonly policyDigest: string }
  | {
      readonly ok: false
      readonly reason: 'excluded-history'
      readonly policyDigest: string
      readonly excludedPaths: readonly string[]
    }
  | { readonly ok: false; readonly reason: 'failed'; readonly error: string }

export type TaskWorkspaceCommitFreezeResult =
  | {
      readonly ok: true
      readonly commitSha: string
      readonly policyDigest: string
      readonly excludedPaths: readonly string[]
    }
  | {
      readonly ok: false
      readonly reason: 'no-changes'
      readonly policyDigest: string
      readonly excludedPaths: readonly string[]
    }
  | { readonly ok: false; readonly reason: 'failed'; readonly error: string }

export interface TaskWorkspaceCommitParticipant {
  preview(): Promise<TaskWorkspaceCommitPreviewResult>
  freeze(input: {
    message: string
    keepRef: string
    authorName?: string
    authorEmail?: string
  }): Promise<TaskWorkspaceCommitFreezeResult>
  publish(input: {
    mode: 'cas' | 'new'
    baseSha: string
    tipSha: string
    remote: string
    branch: string
  }): Promise<TaskWorkspaceCommitPublishResult>
  release(input: { ref: string }): Promise<{ ok: true } | { ok: false; error: string }>
}

// RFC-359 AC-1 的进程内活跃度参与者端口（`ActiveTaskExecutionParticipant`）此前从这里出去，只因 legacy 的
// `services/taskDelete.ts` 不得 import 模块内部；RFC-476 后删除实现在 task-execution 内，直接取定义处。

export type { TaskExecutionPermits } from '../application/ports/taskExecutionPermits'

/** The execution demand owns the joint invocation consumed by system runs. */
export type { AgentInvocationBinding } from '../application/ports/agentInvocation'
export type {
  RuntimeSmokeInvocationFamily,
  RuntimeSmokeRunFamily,
  RuntimeSmokeRunRequest,
} from '../application/ports/runtimeSmoke'
export type { SystemAgentObservationRun } from '../application/ports/systemAgentObservation'
export type { PreparedSystemAgentRunResult } from '../application/ports/systemAgentRun'
export type {
  SystemAgentRunFamily,
  SystemAgentRunRequest,
} from '../application/ports/systemAgentRunFamily'
export { classifyMissingEnvelope } from '../application/systemAgentRun'

/** RFC-370 v3 V5: Task Execution's hosted restore normalization participant. */
export type { SelectionChange, SelectionRevision } from '../application/ports/runSelection'
export { createHostedRestoreTaskNormalization } from '../infrastructure/hostedRestoreNormalization'

export type {
  ConsumedInputsParticipantInTx,
  ConsumedInputsWrite,
} from '../application/ports/consumedInputs'
export {
  createConsumedInputsParticipantInTx,
  prepareConsumedInputs,
} from '../infrastructure/consumedInputsParticipant'

export { reselectRunInTx } from '../infrastructure/runSelection/selectionWrite'

export type { HumanGatePersistenceParticipantInTx } from '../application/ports/humanGatePersistenceParticipant'
export { createHumanGatePersistenceParticipantInTx } from '../infrastructure/humanGatePersistenceParticipant'

export type { TaskClarifyDirectivePersistence } from '../application/ports/taskClarifyDirectivePersistence'
export { createTaskClarifyDirectivePersistence } from '../infrastructure/taskClarifyDirectivePersistence'

export type { TaskPreparationParticipant } from '../application/ports/taskPreparation'
export { createTaskPreparationParticipantInTx } from '../infrastructure/taskPreparationParticipant'

export { TaskAggregateCasMiss } from '../infrastructure/taskDefinitionWriteParticipant'

// RFC-476 —— 评审写入与任务取消共用的进程内每任务 FIFO（原 `services/reviewMutationCoordinator.ts`）归 task-execution；
// collaboration 的评审与协作者写入经这个闭合接口参与方进同一个队列（评审作用域解析与找不到的错误留在 collaboration）。
export { taskReviewMutationQueue } from '../infrastructure/reviewMutationQueue'
