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

/** Closed scheduler/Worker persistence participant. Both providers implement
 * the same async lease/fence state machine. */
export interface MaintenanceRunStore {
  enqueue(input: EnqueueMaintenanceRunInput): Promise<{
    readonly row: MaintenanceRunRecord
    readonly inserted: boolean
    readonly coalesced: boolean
  }>
  recoverExpired(now: number): Promise<number>
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
  hasCycle(cycleKey: string): Promise<boolean>
  readProjection(): Promise<{
    readonly active: MaintenanceRunRecord | null
    readonly last: MaintenanceRunRecord | null
    readonly backlog: readonly MaintenanceRunRecord[]
  }>
}
