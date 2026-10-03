import { z } from 'zod'
import { ObservationOverviewQuerySchema } from './observationTasks'
import type { ObservationTaskFacts, ObservationDimensionSelection } from './observationTasks'
import type { CompleteObservationMetrics, CompleteObservationTask } from './observationComplete'
import type { AcceptedObservationInvocation } from './observationInvocation'

export const COMPLETE_OBSERVATION_SECTIONS = [
  'tasks',
  'agents',
  'runtimes',
  'models',
  'purposes',
  'sources',
  'trends',
  'quality',
  'attempts',
  'invocations',
  'allocations',
  'native-captures',
  'platform-captures',
  'dimension-tasks',
  'receipts',
  'span-facts',
  'span-captures',
  'span-statuses',
] as const
export type CompleteObservationSection = (typeof COMPLETE_OBSERVATION_SECTIONS)[number]
export const CompleteObservationReportQuerySchema = ObservationOverviewQuerySchema
export const CompleteObservationReportRequestSchema = z
  .object({
    filters: CompleteObservationReportQuerySchema,
    refreshKey: z.string().min(1).max(200),
    taskId: z.string().min(1).max(512).optional(),
  })
  .strict()
export const CompleteObservationPageQuerySchema = z
  .object({
    section: z.enum(COMPLETE_OBSERVATION_SECTIONS),
    parent: z.string().min(1).max(4096).optional(),
    after: z.string().min(1).max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict()
export interface CompleteObservationReportHeader {
  readonly reportId: string
  readonly projectionVersion: 2
  readonly generation: string
  readonly snapshotId: string
  readonly asOf: number
  readonly sourceRevision: string
  readonly actorScope: string
  readonly authorizationRevision: string
  readonly filters: z.infer<typeof CompleteObservationReportQuerySchema>
  readonly taskId: string | null
}
export interface CompleteObservationReportSummary {
  readonly metrics: CompleteObservationMetrics
  readonly inventory: {
    readonly tasks: string
    readonly attempts: string
    readonly invocations: string
    readonly numericRecords: string
    readonly nativeCaptures: string
  }
  readonly statuses: Readonly<Record<string, string>>
  readonly timing: {
    readonly p50Ms: string | null
    readonly p95Ms: string | null
    readonly wallMs: string
    readonly runningMs: string
    readonly unknown: string
  }
  /** A requested Task and all its descendants; physical Task rows retain their own disjoint usage. */
  readonly rootTask: CompleteObservationTask | null
}
export type CompleteObservationReport =
  | { readonly state: 'building'; readonly reportId: string; readonly phase: string }
  | { readonly state: 'not-ready'; readonly reportId: string; readonly gaps: readonly string[] }
  | {
      readonly state: 'failed'
      readonly reportId: string
      readonly error: string
      readonly retryable: boolean
    }
  | {
      readonly state: 'ready'
      readonly header: CompleteObservationReportHeader
      readonly summary: CompleteObservationReportSummary
      readonly counts: Readonly<Partial<Record<CompleteObservationSection, string>>>
    }
export interface CompleteObservationReportPage<T> {
  readonly reportId: string
  readonly section: CompleteObservationSection
  readonly parent: string | null
  readonly items: readonly T[]
  readonly total: string
  readonly nextCursor: string | null
}
export interface CompleteObservationDimension {
  readonly key: string
  readonly kind: 'agent' | 'runtime' | 'model' | 'purpose' | 'source'
  readonly label: string | null
  readonly selection: ObservationDimensionSelection
  readonly metrics: CompleteObservationMetrics
  readonly taskCount: string
}
export interface CompleteObservationTrend {
  readonly key: string
  readonly from: number
  readonly to: number
  readonly tasks: string
  readonly metrics: CompleteObservationMetrics
}
export interface CompleteObservationQuality {
  readonly key: string
  readonly taskCount: string
}
export interface CompleteObservationDimensionTask {
  readonly task: ObservationTaskFacts
  readonly metrics: CompleteObservationMetrics
  readonly timing: CompleteObservationTask['timing']
}
export interface CompleteObservationInvocation extends AcceptedObservationInvocation {
  readonly metrics: CompleteObservationMetrics
  readonly taskName: string
  readonly agentName: string | null
}
