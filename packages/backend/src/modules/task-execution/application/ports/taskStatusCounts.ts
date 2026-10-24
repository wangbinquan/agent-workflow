import type { NativeDatabaseReadSource } from '@/platform/persistence/nativeReadSource'

export type TaskLifecycleCountSource = NativeDatabaseReadSource

export interface TaskStatusCountQueries {
  countRunningTasks(): Promise<number>
}

export interface TaskLifecycleCounts {
  countLifecycleStates(source: TaskLifecycleCountSource): Promise<{
    readonly interrupted: number
    readonly failed: number
    readonly awaitingReview: number
    readonly awaitingHuman: number
    readonly quarantined: number
  }>
}
