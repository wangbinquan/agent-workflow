import type { MaintenanceJobClass, MaintenanceJobKey } from '@agent-workflow/shared'

export type MaintenanceRunState = 'pending' | 'running' | 'deferred' | 'succeeded' | 'failed'

/** Provider-neutral durable maintenance row. Database column names and query
 * builders stay in infrastructure; the scheduler/worker only owns this state
 * machine contract. */
export interface MaintenanceRunRecord {
  readonly id: string
  readonly jobKey: string
  readonly jobClass: MaintenanceJobClass
  readonly slotKey: string
  readonly cycleKey: string | null
  readonly state: MaintenanceRunState
  readonly payloadJson: string
  readonly cursorVersion: number
  readonly cursorJson: string | null
  readonly leaseToken: string | null
  readonly leaseExpiresAt: number | null
  readonly heartbeatAt: number | null
  readonly attempt: number
  readonly sliceNo: number
  readonly countersJson: string
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly scheduledAt: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
}

export interface EnqueueMaintenanceRunInput {
  readonly id: string
  readonly jobKey: MaintenanceJobKey
  readonly jobClass: MaintenanceJobClass
  readonly slotKey: string
  readonly cycleKey?: string | null
  readonly payload: Readonly<Record<string, unknown>>
  readonly scheduledAt: number
  readonly now: number
}

export interface ClaimedMaintenanceRun {
  readonly row: MaintenanceRunRecord
  readonly leaseToken: string
}

/** Closed scheduler/Worker persistence participant. One implementation
 * (`platform/persistence/maintenanceRunStore.ts`) serves both providers; this
 * port is the contract the scheduler and the maintenance Worker own. */
export interface MaintenanceRunStore {
  enqueue(input: EnqueueMaintenanceRunInput): Promise<{
    readonly row: MaintenanceRunRecord
    readonly inserted: boolean
    readonly coalesced: boolean
  }>
  /**
   * 恢复所有 `running` 行（Worker 启动时的唯一恢复入口）。
   *
   * RFC-359 W8：此前还有一个只按 `leaseExpiresAt < now` 恢复的 `recoverExpired`，
   * **生产从来没有调用过它**（唯一的恢复调用点是 `maintenanceWorker.ts` 初始化时的
   * `recoverRunning`），已随合一删除。租约过期本身仍由这条路径在下次 Worker 启动时兜住。
   */
  recoverRunning(now: number): Promise<number>
  claimNext(input: {
    readonly leaseToken: string
    readonly now: number
    readonly leaseMs: number
  }): Promise<ClaimedMaintenanceRun | null>
  heartbeat(input: {
    readonly runId: string
    readonly leaseToken: string
    readonly now: number
    readonly leaseMs: number
    readonly counters?: Readonly<Record<string, number>>
  }): Promise<boolean>
  settle(input: {
    readonly runId: string
    readonly leaseToken: string
    readonly now: number
    readonly outcome: 'succeeded' | 'failed' | 'deferred'
    readonly counters?: Readonly<Record<string, number>>
    readonly cursor?: object | null
    readonly errorCode?: string
    readonly errorMessage?: string
    readonly nextAttemptAt?: number
  }): Promise<boolean>
  read(runId: string): Promise<MaintenanceRunRecord | null>
  readProjection(): Promise<{
    readonly active: MaintenanceRunRecord | null
    readonly last: MaintenanceRunRecord | null
    readonly backlog: readonly MaintenanceRunRecord[]
  }>
}
