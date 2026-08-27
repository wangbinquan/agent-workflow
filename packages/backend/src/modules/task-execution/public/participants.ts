// RFC-303 — the only cross-context task-control surface.
// It deliberately accepts a source binding, never caller-selected task ids.
import type { WorkspaceFailureClass } from '@/modules/digital-employee/public/types'
import type { TaskStatus } from '@agent-workflow/shared'
import {
  DEFAULT_OWNERSHIP_HEARTBEAT_MS,
  DEFAULT_OWNERSHIP_LEASE_MS,
  taskExecutionModule as taskExecutionModuleInternal,
} from '../composition'
import { createCodeHostEffectAttemptObserver as createCodeHostEffectAttemptObserverInternal } from '../application/codeHostEffectObserver'
import { createLocalEffectAttemptObserver as createLocalEffectAttemptObserverInternal } from '../application/localEffectObserver'
import {
  withCurrentTaskExecutionMutation as withCurrentTaskExecutionMutationInternal,
  withCurrentTaskExecutionTransaction as withCurrentTaskExecutionTransactionInternal,
  withTaskExecutionMutation as withTaskExecutionMutationInternal,
  withTaskExecutionTransaction as withTaskExecutionTransactionInternal,
} from '../application/ownedTaskMutation'
import { createProcessEffectAttemptObserver as createProcessEffectAttemptObserverInternal } from '../application/processEffectObserver'
import {
  assertTaskExecutionContext as assertTaskExecutionContextInternal,
  createTaskExecutionContext as createTaskExecutionContextInternal,
  currentTaskExecutionContext as currentTaskExecutionContextInternal,
  runWithTaskExecutionContext as runWithTaskExecutionContextInternal,
} from '../application/taskExecutionContext'
import { TaskExecutionError as TaskExecutionErrorInternal } from '../application/taskExecutionError'
import { submitTaskContinuationTx as submitTaskContinuationTxInternal } from '../application/submitTaskContinuation'
import type {
  AcceptHumanGateDecisionInput,
  AcceptedHumanGateDecision,
  TaskDecisionParticipantInTx,
} from '../application/acceptHumanGateDecision'
import { terminalizeTaskExecutionIntentsTx as terminalizeTaskExecutionIntentsTxInternal } from '../application/terminalizeExecutionIntent'
import {
  finalizeTaskExecutionRecovery as finalizeTaskExecutionRecoveryInternal,
  prepareTaskExecutionRecovery as prepareTaskExecutionRecoveryInternal,
} from '../application/recoverTaskExecutions'
import { bindTaskDecisionParticipantInTx as bindTaskDecisionParticipantInTxInternal } from '../composition/humanGate'
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
  createExclusiveDaemonLockProof as createExclusiveDaemonLockProofInternal,
  createVerifiedOutcomeUnknownClosure as createVerifiedOutcomeUnknownClosureInternal,
  createVerifiedStopProof as createVerifiedStopProofInternal,
  exactOwnerMatches as exactOwnerMatchesInternal,
  ownershipTokenKey as ownershipTokenKeyInternal,
} from '../domain/ownership'
import {
  humanGateNodeProjectionFence as humanGateNodeProjectionFenceInternal,
  type HumanGateContinuationLineage,
  type HumanGateNodeProjectionFence,
  type HumanGateWorkspaceRollbackRef,
} from '../domain/humanGateContinuation'
import type {
  MaintenanceMemberSnapshot,
  TerminalMaintenanceState,
} from '../domain/terminalMaintenance'
import type { RecoverableTerminalMaintenanceClaim } from '../application/ports/terminalMaintenanceStore'

declare const sourceTerminationCapabilityBrand: unique symbol
declare const workerIdentityBrand: unique symbol
declare const ownershipTokenBrand: unique symbol
declare const ownedTaskTxBrand: unique symbol
declare const maintenanceClaimBrand: unique symbol
declare const codeHostSendAttemptHandleBrand: unique symbol

export type SourceTerminationEffectCapability = Readonly<{
  [sourceTerminationCapabilityBrand]: true
}>

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
  LineageSlot,
  MaintenanceMemberSnapshot,
  RecoverableTerminalMaintenanceClaim,
  TaskExecutionIntentKind,
  TaskExecutionIntentSource,
  TerminalMaintenanceState,
  TaskDecisionParticipantInTx,
  HumanGateContinuationLineage,
  HumanGateNodeProjectionFence,
  HumanGateWorkspaceRollbackRef,
}

export type CodeHostSendAttemptHandle = Readonly<{
  [codeHostSendAttemptHandleBrand]: true
}>

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

export interface CodeHostSendAttemptObserver {
  beforeSend(
    info: CodeHostSendAttemptInfo,
  ): Promise<CodeHostSendAttemptHandle | null> | CodeHostSendAttemptHandle | null
  afterSend(
    handle: CodeHostSendAttemptHandle | null,
    settlement: CodeHostSendAttemptSettlement,
  ): Promise<void> | void
  /** True only after a terminal send whose application outcome is ambiguous. */
  outcomeUnknown?(): boolean
}

// Exact provider-facing adapters used while the legacy orchestration files are
// being moved behind RFC-294 W2. Constructors and stores stay owned by this
// context; production calls remain constrained by RFC-328's exact source
// allowlists.
export { DEFAULT_OWNERSHIP_HEARTBEAT_MS, DEFAULT_OWNERSHIP_LEASE_MS }
export const taskExecutionModule = taskExecutionModuleInternal
export const createCodeHostEffectAttemptObserver = createCodeHostEffectAttemptObserverInternal
export const createLocalEffectAttemptObserver = createLocalEffectAttemptObserverInternal
export const createProcessEffectAttemptObserver = createProcessEffectAttemptObserverInternal
export const assertTaskExecutionContext = assertTaskExecutionContextInternal
export const createTaskExecutionContext = createTaskExecutionContextInternal
export const currentTaskExecutionContext = currentTaskExecutionContextInternal
export const runWithTaskExecutionContext = runWithTaskExecutionContextInternal
export const withCurrentTaskExecutionMutation = withCurrentTaskExecutionMutationInternal
export const withCurrentTaskExecutionTransaction = withCurrentTaskExecutionTransactionInternal
export const withTaskExecutionMutation = withTaskExecutionMutationInternal
export const withTaskExecutionTransaction = withTaskExecutionTransactionInternal
export const submitTaskContinuationTx = submitTaskContinuationTxInternal
export const bindTaskDecisionParticipantInTx = bindTaskDecisionParticipantInTxInternal
export const humanGateNodeProjectionFence = humanGateNodeProjectionFenceInternal
export const terminalizeTaskExecutionIntentsTx = terminalizeTaskExecutionIntentsTxInternal
export const prepareTaskExecutionRecovery = prepareTaskExecutionRecoveryInternal
export const finalizeTaskExecutionRecovery = finalizeTaskExecutionRecoveryInternal
export const buildCodeHostRecoveryDescriptor = buildCodeHostRecoveryDescriptorInternal
export const classifyCodeHostProbeResponse = classifyCodeHostProbeResponseInternal
export const codeHostRecoveryBaseUrlDigest = codeHostRecoveryBaseUrlDigestInternal
export const operationFamilyKey = operationFamilyKeyInternal
export const taskExecutionRequestHash = taskExecutionRequestHashInternal
export const canonicalTaskExecutionJson = canonicalTaskExecutionJsonInternal
export const decodeLineageSlotPath = decodeLineageSlotPathInternal
export const encodeLineageSlotPath = encodeLineageSlotPathInternal
export const createExclusiveDaemonLockProof = createExclusiveDaemonLockProofInternal
export const createVerifiedOutcomeUnknownClosure = createVerifiedOutcomeUnknownClosureInternal
export const createVerifiedStopProof = createVerifiedStopProofInternal
export const exactOwnerMatches = exactOwnerMatchesInternal
export const ownershipTokenKey = ownershipTokenKeyInternal
export const TaskExecutionError = TaskExecutionErrorInternal

export type TaskSourceTerminationEffectInput = Readonly<{
  effectId: string
  binding: string
  streamRevision: number
  kind: 'fence-closed' | 'fence-merged' | 'clear-closed'
  deliveryId: string
}>

export type TaskSourceTerminationReceipt = Readonly<{
  taskId: string
  priorStatus: TaskStatus
  fenceOutcome: 'fenced-closed' | 'fenced-merged' | 'cleared-closed' | 'unchanged'
  cancelOutcome: 'canceled' | 'already-terminal' | 'not-applicable'
  releaseOutcome: 'pending' | 'no-active-owner' | 'released' | 'unreaped' | 'not-required'
  errorCode: string | null
}>

export interface TaskSourceTerminationParticipant {
  apply(
    capability: SourceTerminationEffectCapability,
    input: TaskSourceTerminationEffectInput,
  ): Promise<readonly TaskSourceTerminationReceipt[]>
}

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

export type DigitalEmployeeExecutionResult =
  | { readonly kind: 'pending'; readonly executionRef: string }
  | { readonly kind: 'completed'; readonly executionRef: string; readonly outputJson: string }
  | {
      readonly kind: 'failed'
      readonly executionRef: string
      /** RFC-317 T31（DE-03）—— 决定 OS 的重试落在同场景还是新场景。 */
      readonly errorClass: WorkspaceFailureClass
      readonly errorCode: string
      readonly errorDetail: string
    }

export type DigitalEmployeeHumanReviewState = 'planning' | 'waiting' | 'approved' | 'failed'

/** Exact TaskEngine lane used by the Digital Employee OS. */
export interface DigitalEmployeeExecutionParticipant {
  launch(planJson: string, attemptJson: string): Promise<{ readonly executionRef: string }>
  inspect(executionRef: string): Promise<DigitalEmployeeExecutionResult>
  inspectHumanReview?(executionRef: string): DigitalEmployeeHumanReviewState | null
  cancel(executionRef: string): Promise<void>
}
