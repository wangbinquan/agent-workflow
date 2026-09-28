import { z } from 'zod'
import type {
  ObservationTokenUsage,
  ObservationNativeCapture,
  ObservationNativeRevisionResolution,
} from './observationUsage'
import { TaskStatusSchema } from './task'

const time = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const ObservationTaskPageQuerySchema = z
  .object({
    from: time,
    to: time,
    timezone: z.string().min(1).max(100).default('UTC'),
    q: z.string().trim().min(1).max(200).optional(),
    status: TaskStatusSchema.optional(),
    repository: z.string().trim().min(1).max(4096).optional(),
    workflow: z.string().trim().min(1).max(200).optional(),
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

export const ObservationOverviewQuerySchema = ObservationTaskPageQuerySchema.refine(
  (query) => query.after === undefined && query.limit === 20,
  {
    message: 'Overview does not accept task pagination',
  },
).transform(({ from, to, timezone, q, status, repository, workflow }) => ({
  from,
  to,
  timezone,
  ...(q === undefined ? {} : { q }),
  ...(status === undefined ? {} : { status }),
  ...(repository === undefined ? {} : { repository }),
  ...(workflow === undefined ? {} : { workflow }),
}))
export type ObservationOverviewQuery = z.infer<typeof ObservationOverviewQuerySchema>

/** A fresh bounded snapshot. Large asynchronous exports have a separate contract. */
export const ObservationSnapshotExportQuerySchema = z
  .object({
    window: ObservationOverviewQuerySchema,
    view: z.enum(['tasks', 'agents']),
    agent: z.string().min(1).max(2048).optional(),
    quality: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((query) => query.agent === undefined || query.view === 'agents', {
    message: 'Agent selection requires the agents view',
  })
  .refine((query) => query.quality === undefined || query.view === 'tasks', {
    message: 'Quality selection requires the tasks view',
  })
export type ObservationSnapshotExportQuery = z.infer<typeof ObservationSnapshotExportQuerySchema>
export const ObservationSnapshotExportSchema = z
  .object({
    filename: z.string().regex(/^aw-observations-(tasks|agents)-\d+-\d+\.csv$/),
    mediaType: z.literal('text/csv;charset=utf-8'),
    content: z.string().max(16 * 1024 * 1024),
    rows: z.number().int().min(0).max(10000),
    asOf: time,
    partial: z.boolean(),
    bounded: z.literal(true),
  })
  .strict()
export type ObservationSnapshotExport = z.infer<typeof ObservationSnapshotExportSchema>

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
  readonly nativeCaptures?: readonly {
    readonly invocationId: string
    readonly nodeRunId: string | null
    readonly state: 'pending' | 'partial' | 'complete' | 'unobserved'
    readonly priorRevisionGap: boolean
    readonly proof: ObservationNativeCapture | null
    readonly issues?: readonly string[]
    readonly revisions?: readonly ObservationNativeRevisionResolution[]
  }[]
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
    readonly platformProjectId: string | null
    readonly platformTaskId: string | null
    readonly status: 'initial' | 'syncing' | 'ready' | 'failed' | 'legacy-unbound'
    readonly asOf: string | null
    readonly error: string | null
    readonly costsVisible: boolean
    readonly hasGaps: boolean
  }[]
}

/** AW-local durable execution source. Platform synchronization has its own status. */
export interface ObservationSourceBacklog {
  readonly taskId: string
  readonly retainedRecords: number
  readonly pendingRecords: number
}
export interface ObservationCollectionStatus {
  readonly retainedRecords: number
  readonly pendingRecords: number
  readonly firstObservedAt: number | null
  readonly lastObservedAt: number | null
  readonly tasks: readonly (ObservationSourceBacklog & {
    readonly firstObservedAt: number | null
    readonly lastObservedAt: number | null
  })[]
  readonly platforms: readonly (ObservationTaskDetail['sources'][number] & {
    readonly taskId: string
  })[]
}

export interface ObservationOverview {
  readonly asOf: number
  readonly projectionVersion: 1
  readonly cohort: 'started'
  readonly taskScope: 'direct'
  readonly filtersEcho: ObservationOverviewQuery
  readonly partial: boolean
  /** Collection evidence in this task cohort. No pending rows is not proof of complete capture. */
  readonly collection: ObservationCollectionStatus
  readonly limits: {
    readonly tasks: number
    readonly invocations: number
    readonly records: number
  }
  readonly metrics: ObservationMetrics
  readonly tasks: readonly ObservationTaskSummary[]
  readonly statuses: readonly { readonly status: string; readonly count: number }[]
  readonly trend: readonly {
    readonly from: number
    readonly to: number
    readonly taskCount: number
    readonly metrics: ObservationMetrics
  }[]
  readonly agents: readonly (ObservationAgentSummary & {
    readonly tasks: readonly { readonly taskId: string; readonly metrics: ObservationMetrics }[]
  })[]
  readonly models: readonly {
    readonly authority: 'local' | 'crewstation'
    readonly sourceId: string | null
    readonly provider: string | null
    readonly model: string | null
    readonly metrics: ObservationMetrics
  }[]
  readonly runtimes: readonly {
    readonly authority: 'local' | 'crewstation'
    readonly sourceId: string | null
    readonly registrationId: string | null
    readonly configurationRevision: number | null
    readonly protocol: string | null
    readonly metrics: ObservationMetrics
  }[]
  readonly durations: {
    readonly completedTasks: number
    readonly p50Ms: number | null
    readonly p95Ms: number | null
    readonly maxMs: number | null
  }
  readonly quality: readonly {
    readonly reason: string
    readonly taskIds: readonly string[]
  }[]
}
