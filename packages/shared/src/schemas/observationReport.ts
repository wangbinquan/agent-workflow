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
  'quality-tasks',
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
  'historical-executions',
  'historical-records',
  'historical-record-versions',
  'historical-record-references',
  'time-partitions',
  'time-unassigned',
] as const
export type CompleteObservationSection = (typeof COMPLETE_OBSERVATION_SECTIONS)[number]
/** Execution facts remain available only after the same complete input and output seals. */
export const COMPLETE_OBSERVATION_FACT_SECTIONS: readonly CompleteObservationSection[] = [
  'tasks',
  'agents',
  'runtimes',
  'models',
  'purposes',
  'sources',
  'trends',
  'quality',
  'quality-tasks',
  'attempts',
  'invocations',
  'dimension-tasks',
  'span-facts',
  'span-statuses',
  'historical-executions',
  'historical-records',
  'historical-record-versions',
  'historical-record-references',
  'time-partitions',
  'time-unassigned',
]
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
  /** Every received record in the sealed scope; full usage may still be unknown. */
  readonly recordedUsage?: CompleteObservationTrend['recordedUsage']
  readonly usageWindow?: {
    readonly candidateTasks: string
    readonly timingBasis: 'task-lifecycle'
    readonly partitions: Readonly<
      Record<
        'in-window' | 'outside-window' | 'unassigned-time',
        {
          readonly records: string
          readonly metrics: CompleteObservationMetrics
        }
      >
    >
  }
  /** Exact Task states counted during the original full traversal; absent in older reports. */
  readonly usageCoverage?: {
    readonly readyTasks: string
    readonly missingTasks: string
    readonly notApplicableTasks: string
  }
  readonly inventory: {
    readonly tasks: string
    readonly attempts: string
    readonly invocations: string
    readonly numericRecords: string
    readonly nativeCaptures: string
    readonly historicalReferences?: string
  }
  readonly statuses: Readonly<Record<string, string>>
  readonly timing: {
    readonly p50Ms: string | null
    readonly p95Ms: string | null
    readonly wallMs: string
    readonly runningMs: string | null
    /** Exact running-state coverage; absent in older or fully observed reports. */
    readonly runningCoverage?: { readonly tasks: string; readonly observedTasks: string }
    /** Known running-state subtotal, present only when at least one Task is observed. */
    readonly recordedRunningMs?: string
    readonly unknown: string
  }
  /** A requested Task and all its descendants; physical Task rows retain their own disjoint usage. */
  readonly rootTask: CompleteObservationTask | null
}
export interface CompleteObservationFactSummary {
  readonly metrics: Extract<CompleteObservationMetrics, { state: 'not-ready' }>
  readonly recordedUsage?: CompleteObservationReportSummary['recordedUsage']
  readonly usageWindow?: CompleteObservationReportSummary['usageWindow']
  readonly usageCoverage?: CompleteObservationReportSummary['usageCoverage']
  readonly inventory: {
    readonly tasks: string
    readonly attempts: string
    readonly invocations: string
    readonly historicalReferences?: string
  }
  readonly statuses: Readonly<Record<string, string>>
  readonly timing: {
    readonly p50Ms: string | null
    readonly p95Ms: string | null
    readonly wallMs: string
    readonly runningMs: string | null
    readonly runningCoverage?: { readonly tasks: string; readonly observedTasks: string }
    readonly recordedRunningMs?: string
    readonly unknown: string
  }
  readonly rootTask: CompleteObservationTask | null
}
export interface CompleteObservationReportContent {
  readonly header: CompleteObservationReportHeader
  readonly summary: CompleteObservationReportSummary | CompleteObservationFactSummary
  readonly counts: Readonly<Partial<Record<CompleteObservationSection, string>>>
}
export type CompleteObservationReport =
  | { readonly state: 'building'; readonly reportId: string; readonly phase: string }
  | {
      readonly state: 'not-ready'
      readonly reportId: string
      readonly gaps: readonly string[]
      readonly facts?: {
        readonly header: CompleteObservationReportHeader
        readonly summary: CompleteObservationFactSummary
        readonly counts: Readonly<Partial<Record<CompleteObservationSection, string>>>
      }
    }
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
/** No state is rewritten: this selects sealed content without claiming numeric readiness. */
export function completeObservationReportContent(
  report: CompleteObservationReport,
): CompleteObservationReportContent | null {
  return report.state === 'ready'
    ? report
    : report.state === 'not-ready'
      ? (report.facts ?? null)
      : null
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
  /** All received ledger records in this sealed day; never the unknown full usage total. */
  readonly recordedUsage?: {
    readonly invocations: string
    readonly observedInvocations: string
    readonly records: string
    readonly tokens: Extract<CompleteObservationMetrics, { state: 'ready' }>['tokens']
  }
}
export interface CompleteObservationQuality {
  readonly key: string
  readonly taskCount: string
  /** Associations exist only after the original parent population matches taskCount. */
  readonly taskIndexVersion?: 1
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
