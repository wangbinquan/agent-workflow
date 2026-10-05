import { z } from 'zod'
import type {
  ObservationTokenUsage,
  ObservationUsageCapture,
  ObservationNativeRevisionResolution,
} from './observationUsage'
import { TaskStatusSchema } from './task'
import type { ObservationPlatformNativeCapture } from './observationPlatform'

const time = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identity = z.string().min(1).max(2048).nullable()
const authority = z.enum(['local', 'crewstation'])
export const ObservationDimensionSelectionSchema = z
  .object({
    runtime: z
      .object({
        authority,
        sourceId: identity,
        registrationId: identity,
        configurationRevision: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .nullable(),
        protocol: identity,
      })
      .strict()
      .refine((value) =>
        value.authority === 'local'
          ? value.sourceId === null
          : value.registrationId === null &&
            value.configurationRevision === null &&
            value.protocol === null,
      )
      .optional(),
    model: z
      .object({ authority, sourceId: identity, provider: identity, model: identity })
      .strict()
      .refine((value) =>
        value.authority === 'local' ? value.sourceId === null : value.provider === null,
      )
      .optional(),
    agent: z
      .object({
        id: identity,
        revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
      })
      .strict()
      .optional(),
    purpose: z.enum(['task', 'system', 'playground', 'memory']).optional(),
    source: z
      .object({ authority, sourceId: identity })
      .strict()
      .refine((value) => value.authority !== 'local' || value.sourceId === null)
      .optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Empty observation dimension selection',
  })
export type ObservationDimensionSelection = z.infer<typeof ObservationDimensionSelectionSchema>
const selection = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) => {
      try {
        return ObservationDimensionSelectionSchema.safeParse(JSON.parse(value)).success
      } catch {
        return false
      }
    },
    { message: 'Invalid observation dimension selection' },
  )
export const ObservationTaskPageQuerySchema = z
  .object({
    from: time,
    to: time,
    timezone: z.string().min(1).max(100).default('UTC'),
    q: z.string().trim().min(1).max(200).optional(),
    status: TaskStatusSchema.optional(),
    repository: z.string().trim().min(1).max(4096).optional(),
    workflow: z.string().trim().min(1).max(200).optional(),
    selection: selection.optional(),
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
).transform(({ from, to, timezone, q, status, repository, workflow, selection }) => ({
  from,
  to,
  timezone,
  ...(q === undefined ? {} : { q }),
  ...(status === undefined ? {} : { status }),
  ...(repository === undefined ? {} : { repository }),
  ...(workflow === undefined ? {} : { workflow }),
  ...(selection === undefined ? {} : { selection }),
}))
export type ObservationOverviewQuery = z.infer<typeof ObservationOverviewQuerySchema>

/** Owner facts, not a copy of task snapshots, prompts or outputs. */
export interface ObservationTaskFacts {
  readonly id: string
  readonly name: string
  readonly status: string
  /** Task-owned diagnostic; absent for observations served by older versions. */
  readonly errorSummary?: string | null
  readonly parentTaskId: string | null
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly runningMs: number
  readonly runningSince: number | null
}
export interface ObservationAttemptFacts {
  readonly id: string
  readonly nodeId: string
  /** Frozen owner node kind; absent historical proof stays unknown. */
  readonly computeKind?: 'agent' | 'non-agent' | 'unknown'
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
    /** Known zero needs affirmative per-bucket evidence, including proven empty captures. */
    readonly hasKnownBuckets?: Readonly<Record<keyof ObservationTokenUsage, boolean>>
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
  /** A selected contribution is incomplete or could not be assigned to this range. */
  readonly dimensionMatch?: 'matched' | 'unresolved'
}
export interface ObservationTaskPage {
  readonly items: readonly ObservationTaskSummary[]
  readonly nextCursor: string | null
  readonly asOf: number
  readonly projectionVersion: 1
  readonly cohort: 'started'
  readonly taskScope: 'direct'
  readonly filtersEcho: ObservationTaskPageQuery
  readonly partial?: boolean
  readonly scannedTasks?: number
  readonly unresolvedTasks?: number
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
  readonly platformCaptures?: readonly {
    readonly invocationId: string
    readonly nodeRunId: string | null
    readonly sourceId: string
    readonly schemaVersion: 1 | 2
    readonly capture: ObservationPlatformNativeCapture | null
    readonly issues: readonly string[]
  }[]
  readonly nativeCaptures?: readonly {
    readonly invocationId: string
    readonly nodeRunId: string | null
    readonly state: 'pending' | 'partial' | 'complete' | 'unobserved'
    readonly priorRevisionGap: boolean
    readonly proof: ObservationUsageCapture | null
    readonly issues?: readonly string[]
    readonly revisions?: readonly ObservationNativeRevisionResolution[]
  }[]
  readonly asOf: number
  readonly projectionVersion: 1
  readonly taskScope: 'direct'
  readonly agents: readonly ObservationAgentSummary[]
  /** Frozen per-runtime usage from this task's authorized snapshot; older responses may omit it. */
  readonly runtimes?: readonly ObservationRuntimeSummary[]
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

/** Display metadata and accounting values are deliberately absent from this identity. */
export interface ObservationRuntimeIdentity {
  readonly authority: 'local' | 'crewstation'
  readonly sourceId: string | null
  readonly registrationId: string | null
  readonly configurationRevision: number | null
  readonly protocol: string | null
}
export function observationRuntimeKey(runtime: ObservationRuntimeIdentity): string {
  return JSON.stringify([
    runtime.authority,
    runtime.sourceId,
    runtime.registrationId,
    runtime.configurationRevision,
    runtime.protocol,
  ])
}
export interface ObservationRuntimeSummary extends ObservationRuntimeIdentity {
  /** Optional for older responses; sourced only from accepted invocation documents. */
  readonly acceptedNames?: readonly string[]
  readonly unnamedInvocations?: number
  /** Direct contribution to each authorized task, never the task's whole consumption. */
  readonly tasks?: readonly { readonly taskId: string; readonly metrics: ObservationMetrics }[]
  readonly metrics: ObservationMetrics
}

export interface ObservationModelIdentity {
  readonly authority: 'local' | 'crewstation'
  readonly sourceId: string | null
  readonly provider: string | null
  readonly model: string | null
}
export function observationModelKey(model: ObservationModelIdentity): string {
  return JSON.stringify([model.authority, model.sourceId, model.provider, model.model])
}

export interface ObservationOverview {
  readonly asOf: number
  readonly projectionVersion: 1
  readonly cohort: 'started'
  readonly taskScope: 'direct'
  readonly filtersEcho: ObservationOverviewQuery
  readonly partial: boolean
  readonly scannedTasks?: number
  readonly unresolvedTasks?: number
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
  readonly models: readonly (ObservationModelIdentity & {
    readonly metrics: ObservationMetrics
    readonly tasks?: readonly { readonly taskId: string; readonly metrics: ObservationMetrics }[]
  })[]
  readonly purposes?: readonly {
    readonly purpose: ObservationAgentSummary['purpose']
    readonly metrics: ObservationMetrics
    readonly tasks: readonly { readonly taskId: string; readonly metrics: ObservationMetrics }[]
  }[]
  readonly sources?: readonly {
    readonly authority: 'local' | 'crewstation'
    readonly sourceId: string | null
    readonly metrics: ObservationMetrics
    readonly tasks: readonly { readonly taskId: string; readonly metrics: ObservationMetrics }[]
  }[]
  readonly runtimes: readonly ObservationRuntimeSummary[]
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
