// RFC-411 — the workgroup turn engine's snapshot, ledger-operation and persistence-port types, moved from
// resource-catalog's turn driver. The engine (engine/task/workgroup) and the persistence adapter
// (infrastructure/workgroupTurnsPersistence.ts) share them.
import type {
  Agent,
  DwState,
  WorkgroupAssignment,
  WorkgroupAssignmentSource,
  WorkgroupAssignmentStatus,
  WorkgroupMessage,
  WorkgroupMessageAuthorKind,
  WorkgroupMessageKind,
  WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import type {
  WorkgroupHostLedgerFailRunOperation,
  WorkgroupHostLedgerMintOperation,
  WorkgroupHostLedgerMintReceipt,
  WorkgroupHostLedgerRun,
  WorkgroupHostLedgerStampOperation,
} from './workgroupTurnsOperations'
import type { WorkgroupTurnGateStatus } from '../../domain/workgroup/turnTransitions'

export interface WorkgroupTurnTaskState {
  readonly gateStatus: WorkgroupTurnGateStatus
  readonly gateSummary: string | null
  readonly gateRejectedComment: string | null
  readonly pauseReason: string | null
  readonly dynamicWorkflowState: DwState | null
  readonly resultMessageId: string | null
}

export interface WorkgroupTurnAssignment extends WorkgroupAssignment {
  readonly attemptCount: number
}

export interface WorkgroupTurnMemberAgent {
  readonly memberId: string
  readonly agent: Agent
  readonly capabilityCard: string
  readonly readonly: boolean
}

export type WorkgroupTurnHostRun = WorkgroupHostLedgerRun

export interface WorkgroupTurnsSnapshot {
  readonly taskId: string
  readonly config: WorkgroupRuntimeConfig
  readonly state: WorkgroupTurnTaskState
  readonly assignments: readonly WorkgroupTurnAssignment[]
  readonly messages: readonly WorkgroupMessage[]
  readonly cursors: ReadonlyMap<string, string>
  readonly memberAgents: readonly WorkgroupTurnMemberAgent[]
  readonly hostRuns: readonly WorkgroupTurnHostRun[]
  readonly leaderClarifyParked: boolean
}

export interface WorkgroupTurnMessageDraft {
  readonly id: string
  readonly round: number
  readonly authorKind: WorkgroupMessageAuthorKind
  readonly authorMemberId: string | null
  readonly authorUserId: string | null
  readonly kind: WorkgroupMessageKind
  readonly bodyMd: string
  readonly templateKey: string | null
  readonly templateParams: Readonly<Record<string, unknown>> | null
  readonly mentionMemberIds: readonly string[]
  readonly assignmentId: string | null
  readonly triggerMessageId: string | null
  readonly createdAt: number
}

export interface WorkgroupTurnAssignmentDraft {
  readonly id: string
  readonly round: number
  readonly source: WorkgroupAssignmentSource
  readonly createdByRunId: string | null
  readonly createdByUserId: string | null
  readonly assigneeMemberId: string | null
  readonly title: string
  readonly briefMd: string
  readonly status: WorkgroupAssignmentStatus
  readonly nodeRunId: string | null
  readonly resultMessageId: string | null
  readonly dedupKey: string | null
  readonly attemptCount: number
  readonly createdAt: number
  readonly updatedAt: number
}

interface WorkgroupTurnLedgerOperationBase {
  readonly operationKey: string
}

export interface WorkgroupTurnEnsureStateOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'ensure-task-state'
  readonly dynamicWorkflowState?: DwState | null
}

export interface WorkgroupTurnSeedGoalOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'seed-goal-if-empty'
  readonly message: WorkgroupTurnMessageDraft
}

export type WorkgroupTurnMintHostRunOperation = WorkgroupHostLedgerMintOperation

export type WorkgroupTurnStampHostRunOperation = WorkgroupHostLedgerStampOperation

export type WorkgroupTurnFailHostRunOperation = WorkgroupHostLedgerFailRunOperation

export interface WorkgroupTurnTransitionAssignmentOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'transition-assignment'
  readonly assignmentId: string
  readonly from: WorkgroupAssignmentStatus
  readonly to: WorkgroupAssignmentStatus
  readonly set?: Readonly<{
    readonly assigneeMemberId?: string | null
    readonly nodeRunId?: string | null
    readonly resultMessageId?: string | null
  }>
  readonly bumpAttempt?: boolean
}

export interface WorkgroupTurnRepointAssignmentOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'repoint-assignment-run'
  readonly assignmentId: string
  readonly nodeRunId: string
}

export interface WorkgroupTurnCreateAssignmentOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'create-assignment'
  readonly assignment: WorkgroupTurnAssignmentDraft
}

export interface WorkgroupTurnCreateMessageOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'create-message'
  readonly message: WorkgroupTurnMessageDraft
}

export interface WorkgroupTurnAdvanceCursorOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'advance-member-cursor'
  readonly memberId: string
  readonly messageId: string
}

export interface WorkgroupTurnGateOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'transition-gate'
  readonly from: readonly WorkgroupTurnGateStatus[]
  readonly to: WorkgroupTurnGateStatus
  readonly summary?: string
  readonly rejectedComment?: string
}

export interface WorkgroupTurnPauseOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'set-pause-reason'
  readonly reason: string | null
}

export interface WorkgroupTurnDynamicWorkflowOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'set-dynamic-workflow-state'
  readonly state: DwState
}

export interface WorkgroupTurnResultAnchorOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'stamp-result-anchor'
  readonly messageId: string
}

export type WorkgroupTurnLedgerOperation =
  | WorkgroupTurnEnsureStateOperation
  | WorkgroupTurnSeedGoalOperation
  | WorkgroupTurnMintHostRunOperation
  | WorkgroupTurnStampHostRunOperation
  | WorkgroupTurnFailHostRunOperation
  | WorkgroupTurnTransitionAssignmentOperation
  | WorkgroupTurnRepointAssignmentOperation
  | WorkgroupTurnCreateAssignmentOperation
  | WorkgroupTurnCreateMessageOperation
  | WorkgroupTurnAdvanceCursorOperation
  | WorkgroupTurnGateOperation
  | WorkgroupTurnPauseOperation
  | WorkgroupTurnDynamicWorkflowOperation
  | WorkgroupTurnResultAnchorOperation

export interface WorkgroupTurnsLedgerCommit {
  readonly taskId: string
  readonly operations: readonly WorkgroupTurnLedgerOperation[]
}

export type WorkgroupTurnMintedRun = WorkgroupHostLedgerMintReceipt

export type WorkgroupTurnsLedgerCommitReceipt =
  | Readonly<{
      committed: true
      mintedRuns: readonly WorkgroupTurnMintedRun[]
      /**
       * 提交时被**幂等跳过**的操作键（目前只有标题去重撞车的建卡）。并发的成员回合各拿同一份快照，
       * 「这一条是不是重复」只可能在提交这一刻定论，所以要报回来让驱动往房间贴系统消息。
       */
      skippedOperationKeys?: readonly string[]
      /** RFC-369 —— `fail-host-run` 真正从 pending 落成 failed 的 run（提交后据此广播）。 */
      failedRunIds?: readonly string[]
    }>
  | Readonly<{ committed: false; conflictOperationKey: string }>

export interface WorkgroupClarifyAllowedInput {
  readonly taskId: string
  readonly nodeId: string
  readonly shardKey: string | null
  readonly members: ReadonlyArray<{ readonly memberType: 'agent' | 'human' }>
  readonly clarifyBudget: number | undefined
}

/** RC 自有的 required 端口：由 bootstrap 用 collaboration 的判定实现（design §3.1 只画 COL→TE，RC 不 import COL）。 */
export interface WorkgroupClarifyAllowedPort {
  allowed(input: WorkgroupClarifyAllowedInput): Promise<boolean>
}

export interface WorkgroupTurnsPersistencePort {
  load(taskId: string): Promise<WorkgroupTurnsSnapshot | null>
  commit(input: WorkgroupTurnsLedgerCommit): Promise<WorkgroupTurnsLedgerCommitReceipt>
  /** RFC-207 §3.7.2 / RFC-359 T7e：这个 asker 此刻能否向人反问——协议块与 clarifyEnabled 共用这一个答案。 */
  clarifyAllowed(input: WorkgroupClarifyAllowedInput): Promise<boolean>
}
