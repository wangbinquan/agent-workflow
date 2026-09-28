import { z } from 'zod'
import type { ObservationTokenUsage } from './observationUsage'

const time = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const ObservationTaskPageQuerySchema = z
  .object({
    from: time,
    to: time,
    timezone: z.string().min(1).max(100).default('UTC'),
    limit: z.coerce.number().int().min(1).max(25).default(20),
    after: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .refine((value) => value.from < value.to, { message: 'Invalid observation window' })
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value.timezone })
        return true
      } catch {
        return false
      }
    },
    { message: 'Invalid observation timezone' },
  )
export type ObservationTaskPageQuery = z.infer<typeof ObservationTaskPageQuerySchema>

/** Owner facts, not a copy of task snapshots, prompts or outputs. */
export interface ObservationTaskFacts {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly parentTaskId: string | null
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly runningMs: number
  readonly runningSince: number | null
}
export interface ObservationAttemptFacts {
  readonly id: string
  readonly nodeId: string
  readonly status: string
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly retryIndex: number
  readonly iteration: number
  readonly wgRound: number | null
  readonly reviewIteration: number
}
export interface ObservationMetrics {
  readonly invocations: number
  readonly observedInvocations: number
  readonly records: number
  readonly tokens: {
    readonly known: Readonly<Record<keyof ObservationTokenUsage, string>>
    readonly totalKnown: string
    readonly hasKnown: boolean
    readonly complete: boolean
    readonly unknownBuckets: Readonly<Record<keyof ObservationTokenUsage, number>>
  }
  readonly cost: {
    readonly currency: 'CNY'
    readonly knownAmount: string | null
    readonly complete: boolean
    readonly pricedRecords: number
    readonly priceVersionIds: readonly string[]
    readonly reasons: readonly string[]
  }
  readonly authorities: readonly ('local' | 'crewstation')[]
  readonly truncated: boolean
}
export interface ObservationTaskSummary {
  readonly task: ObservationTaskFacts
  readonly metrics: ObservationMetrics
  readonly wallMs: number
  readonly runningMs: number
}
export interface ObservationTaskPage {
  readonly items: readonly ObservationTaskSummary[]
  readonly nextCursor: string | null
  readonly asOf: number
  readonly projectionVersion: 1
  readonly cohort: 'started'
  readonly taskScope: 'direct'
  readonly filtersEcho: ObservationTaskPageQuery
}
export interface ObservationAgentSummary {
  readonly agentId: string | null
  readonly agentRevision: number | null
  readonly purpose: 'task' | 'system' | 'playground' | 'memory'
  readonly metrics: ObservationMetrics
}
export interface ObservationAttemptSummary {
  readonly attempt: ObservationAttemptFacts
  readonly metrics: ObservationMetrics
  /** End is known only for a finished attempt or a currently running attempt. */
  readonly interval: { readonly start: number; readonly end: number; readonly open: boolean } | null
  readonly agents: readonly { readonly id: string | null; readonly revision: number | null }[]
}
export interface ObservationTaskDetail extends ObservationTaskSummary {
  readonly asOf: number
  readonly projectionVersion: 1
  readonly taskScope: 'direct'
  readonly agents: readonly ObservationAgentSummary[]
  readonly attempts: readonly ObservationAttemptSummary[]
  readonly attemptsTruncated: boolean
  readonly intervals: {
    readonly cumulativeMs: number
    readonly activeUnionMs: number
    readonly knownAttempts: number
    readonly unknownAttempts: number
    readonly unlinkedInvocations: number
  }
  readonly sources: readonly {
    readonly sourceId: string
    readonly status: 'initial' | 'syncing' | 'ready' | 'failed' | 'legacy-unbound'
    readonly asOf: string | null
    readonly error: string | null
    readonly costsVisible: boolean
    readonly hasGaps: boolean
  }[]
}
