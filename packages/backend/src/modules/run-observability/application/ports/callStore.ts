import type {
  ObservationCallStatus,
  ObservationCostState,
  ObservationUsageState,
} from '@agent-workflow/shared'
import type { ModelUsage, UsageBuckets } from '../../domain/usage'

export interface NewCall {
  readonly id: string
  readonly purpose: 'task' | 'system'
  readonly taskId: string | null
  readonly nodeRunId: string | null
  readonly systemKind: string | null
  readonly systemLabel: string | null
  readonly ownerUserId: string | null
  readonly agentId: string | null
  readonly agentName: string
  readonly runtimeId: string | null
  readonly runtimeName: string | null
  readonly protocol: string
  readonly startedAt: number
}

export interface PricedModelUsage extends ModelUsage {
  readonly priceId: string | null
  readonly costNano: number | null
  readonly costState: ObservationCostState
}

/** One in-place replacement of a call's usage, optionally ending it. */
export interface CallUsageWrite {
  readonly usageState: ObservationUsageState
  readonly totals: UsageBuckets
  readonly costNano: number
  readonly costState: ObservationCostState
  readonly models: readonly PricedModelUsage[]
  readonly updatedAt: number
  readonly end?: {
    readonly status: Exclude<ObservationCallStatus, 'running'>
    readonly endedAt: number
  }
}

export interface CallPricingContext {
  readonly runtimeId: string | null
  readonly startedAt: number
}

/** Which calls a statistics query may see. Task ids are already visibility-checked. */
export type CallScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'tasks'; readonly taskIds: readonly string[] }
  /** Task-less system calls started by one user. */
  | { readonly kind: 'owner'; readonly userId: string }

export interface CallFilter {
  readonly from?: number
  readonly to?: number
  readonly scope: CallScope
  readonly purpose?: 'task' | 'system'
  readonly systemKind?: string
}

export type CallGroup = 'none' | 'purpose' | 'day' | 'task' | 'agent' | 'kind'

/** Additive totals of one group; merging two chunks is element-wise addition. */
export interface CallAggregate {
  readonly key: string | null
  readonly label: string | null
  readonly calls: number
  readonly incompleteCalls: number
  readonly failedCalls: number
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly reasoning: number
  readonly costNano: number
  readonly unpricedCalls: number
  readonly durationMs: number
  readonly tasks: number
  readonly agents: number
}

export interface ModelAggregate extends Omit<
  CallAggregate,
  'key' | 'label' | 'tasks' | 'agents' | 'durationMs'
> {
  readonly runtimeId: string | null
  readonly runtimeName: string | null
  readonly protocol: string
  readonly model: string
}

export interface CallRow extends NewCall {
  readonly status: ObservationCallStatus
  readonly endedAt: number | null
  readonly usageState: ObservationUsageState
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly reasoning: number
  readonly costNano: number
  readonly costState: ObservationCostState
}

export interface CallModelRow extends ModelUsage {
  readonly callId: string
  readonly costNano: number | null
  readonly costState: ObservationCostState
}

export interface CallStore {
  insert(call: NewCall, at: number): Promise<void>
  pricingContext(callId: string): Promise<CallPricingContext | null>
  /** Replaces usage of a running call; ignored once the call has ended. */
  writeUsage(callId: string, write: CallUsageWrite): Promise<void>
  /** Ends a running call without a usage snapshot (pending usage becomes `none`). */
  end(callId: string, end: NonNullable<CallUsageWrite['end']>, at: number): Promise<void>
  /** Calls still running from before this daemon started can no longer report. */
  interruptRunning(bootAt: number, at: number): Promise<number>
  /** Distinct task ids with a call started in the window (at most `limit`). */
  windowTaskIds(from: number, to: number, limit: number): Promise<readonly string[]>
  aggregate(
    filter: CallFilter,
    group: CallGroup,
    dayOffsetMinutes?: number,
  ): Promise<readonly CallAggregate[]>
  aggregateModels(filter: CallFilter): Promise<readonly ModelAggregate[]>
  taskCalls(
    taskId: string,
    limit: number,
  ): Promise<{
    readonly calls: readonly CallRow[]
    readonly models: readonly CallModelRow[]
    readonly truncated: boolean
  }>
  /** Newest first, keyset after `before`. */
  recentCalls(
    filter: CallFilter,
    before: { readonly startedAt: number; readonly id: string } | null,
    limit: number,
  ): Promise<{ readonly calls: readonly CallRow[]; readonly models: readonly CallModelRow[] }>
  /** Models each runtime has reported, for the price directory. */
  runtimeModels(): Promise<
    readonly { readonly runtimeId: string; readonly model: string; readonly calls: number }[]
  >
}
