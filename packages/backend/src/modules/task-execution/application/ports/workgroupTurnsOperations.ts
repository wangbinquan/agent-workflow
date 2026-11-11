// RFC-480: the workgroup-turn and host-ledger port types are declared here. Until RFC-480 this file re-exported them from
// public/commands, where no other context named them (the turn command and the ledger are wired inside this module).
import type { Agent, FailureCode, NodeRunStatus } from '@agent-workflow/shared'
import type { WorkgroupRunSelectionProjection } from '@/platform/runSelectionProjection'
import type { TaskWorkgroupConfig } from '../../domain/taskWorkgroupConfig'

/**
 * Closed logging values accepted by the workgroup-turn command.  Keeping this
 * shape closed prevents the command port from leaking the daemon Logger or an
 * open `Record<string, unknown>` field bag.
 */
export type WorkgroupTurnLogFields = Readonly<{
  taskId?: string
  rowId?: string
  runId?: string
  item?: string
  error?: string
  revived?: number
  count?: number
  dismissed?: number
  doneAssignmentCount?: number
}>

export interface WorkgroupTurnLogger {
  debug(message: string, fields?: WorkgroupTurnLogFields): void
  info(message: string, fields?: WorkgroupTurnLogFields): void
  warn(message: string, fields?: WorkgroupTurnLogFields): void
  error(message: string, fields?: WorkgroupTurnLogFields): void
  child(name: string): WorkgroupTurnLogger
}

export interface WorkgroupTurnHostRequest {
  readonly nodeRunId: string
  readonly nodeId: string
  readonly agent: Agent
  readonly promptTemplate: string
  readonly workgroupProtocolBlock?: string
  readonly discardWrites?: boolean
  readonly clarifyEnabled?: boolean
  readonly hostOutputPorts?: readonly string[]
}

export interface WorkgroupTurnHostResult {
  readonly status: 'done' | 'failed' | 'canceled' | 'awaiting'
  readonly outputs: Readonly<Record<string, string>>
  readonly clarifyQuestionCount?: number
  readonly errorMessage?: string
  readonly processUnreaped?: true
  readonly failureCode?: FailureCode
}

export interface WorkgroupTurnHostOperations {
  runHost(request: WorkgroupTurnHostRequest): Promise<WorkgroupTurnHostResult>
  broadcastNodeStatus?(nodeRunId: string, nodeId: string, status: string): void
  getCanonicalFilesChanged?(): Promise<number>
}

export interface WorkgroupTurnsOutcome {
  readonly kind: 'ok' | 'handoff' | 'failed' | 'canceled' | 'awaiting_review' | 'awaiting_human'
  readonly detail?: Readonly<{
    summary: string
    message: string
    nodeId?: string
    processUnreaped?: true
  }>
  readonly processUnreaped?: true
}

/** Exact TaskExecution command consumed by the workgroup-turn driver. */
export interface WorkgroupTurnsOperations {
  drive(input: {
    readonly taskId: string
    readonly log: WorkgroupTurnLogger
    readonly signal?: AbortSignal
    readonly host: WorkgroupTurnHostOperations
  }): Promise<WorkgroupTurnsOutcome>
}

export interface WorkgroupHostLedgerRun {
  readonly selection: WorkgroupRunSelectionProjection
  readonly seq: number
  readonly id: string
  readonly nodeId: string
  readonly shardKey: string | null
  readonly status: NodeRunStatus
  readonly rerunCause: string | null
  readonly retryIndex: number
  readonly wgRound: number | null
  readonly envelopeNonce: string
}

export interface WorkgroupHostLedgerSnapshot {
  readonly workgroupConfig: TaskWorkgroupConfig | null
  readonly hostRuns: readonly WorkgroupHostLedgerRun[]
  readonly leaderClarifyParked: boolean
}

export interface WorkgroupHostLedgerMintOperation {
  readonly kind: 'mint-host-run'
  readonly operationKey: string
  readonly runId: string
  readonly nodeId: string
  readonly status: 'pending' | 'awaiting_review'
  readonly cause:
    | 'wg-leader-round'
    | 'wg-assignment'
    | 'wg-message-turn'
    | 'wg-protocol-retry'
    | 'wg-gate'
    // RFC-187 T13 / RFC-359 W4-D19c-tail：重启杀掉的「已回答澄清」续跑要按**原样的澄清血缘**
    // 重铸——正是这个 cause 让 buildClarifyQueueContext 把人回答过的 Q&A 重新注回提示词。
    | 'clarify-answer'
    | 'cross-clarify-questioner-rerun'
  readonly retryIndex: number
  readonly shardKey: string | null
  readonly agentOverrideName: string | null
  readonly agentOverrideId: string | null
  readonly wgRound: number | null
}

export interface WorkgroupHostLedgerStampOperation {
  readonly kind: 'stamp-host-run-round'
  readonly operationKey: string
  readonly runId: string
  readonly wgRound: number
}

/**
 * RFC-369 §4.4 —— 工作组一轮在 host 执行中遇到内部错误时，终结本次铸出 / 采纳、却没执行完的宿主 run：
 * 只有库里**仍是 pending** 的才落 failed，其余状态一律空操作（它们已有归宿，不能被改写）。
 */
export interface WorkgroupHostLedgerFailRunOperation {
  readonly kind: 'fail-host-run'
  readonly operationKey: string
  readonly runId: string
  readonly message: string
}

export type WorkgroupHostLedgerOperation =
  | WorkgroupHostLedgerMintOperation
  | WorkgroupHostLedgerStampOperation
  | WorkgroupHostLedgerFailRunOperation

export interface WorkgroupHostLedgerMintReceipt {
  readonly operationKey: string
  readonly runId: string
  readonly envelopeNonce: string
}

/**
 * TaskExecution-owned participant bound to one already-reserved transaction.
 * Resource Catalog may combine these host-ledger atoms with its own workgroup
 * ledger writes without receiving TaskExecution tables or mint mechanics.
 */
export interface WorkgroupHostLedgerParticipantInTx {
  /** Before any ledger write: fence an ambient owner, then acquire the L-1 task root. */
  lockTask(taskId: string): Promise<void>
  load(taskId: string): Promise<WorkgroupHostLedgerSnapshot | null>
  apply(input: {
    readonly taskId: string
    readonly operations: readonly WorkgroupHostLedgerOperation[]
  }): Promise<
    | Readonly<{
        committed: true
        mintedRuns: readonly WorkgroupHostLedgerMintReceipt[]
        /** RFC-369 —— `fail-host-run` 真正从 pending 落成 failed 的 run（调用方提交后据此广播）。 */
        failedRunIds?: readonly string[]
      }>
    | Readonly<{ committed: false; conflictOperationKey: string }>
  >
}
