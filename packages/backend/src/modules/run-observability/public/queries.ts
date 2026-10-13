import type {
  ObservationExecutionComparison,
  ObservationAnomalyPage,
  ObservationStorage,
} from '@agent-workflow/shared'
import type { ObservationMaintenanceCommands } from '../ports/observationMaintenance'
import type {
  ObservationOverview,
  ObservationOverviewQuery,
  ObservationTaskDetail,
  ObservationTaskPage,
  ObservationTaskPageQuery,
  ObservationTaskSpans,
  ObservationTaskSpansQuery,
  CompleteObservationReport,
  CompleteObservationReportPage,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'

/** Pages select output from a completed original report, never its statistical population. */
export interface CompleteObservationReportQueries {
  storage?(): Promise<ObservationStorage>
  compare?(
    actor: Actor,
    id: string,
    left: string,
    right: string,
  ): Promise<ObservationExecutionComparison>
  maintenance?: ObservationMaintenanceCommands
  anomalies?(
    actor: Actor,
    input: { from: number; to: number; after?: string; pageSize: number },
  ): Promise<ObservationAnomalyPage>
  projectionVersion?(): Promise<{ readonly revision: string; readonly asOf: number } | null>
  request(
    actor: Actor,
    query: ObservationOverviewQuery,
    refreshKey: string,
    taskId?: string,
  ): Promise<CompleteObservationReport>
  status(actor: Actor, id: string): Promise<CompleteObservationReport>
  page<T>(actor: Actor, id: string, query: unknown): Promise<CompleteObservationReportPage<T>>
}

export interface ObservationTaskQueries {
  spans?(
    actor: Actor,
    taskId: string,
    query: ObservationTaskSpansQuery,
  ): Promise<ObservationTaskSpans | null>
  overview(actor: Actor, query: ObservationOverviewQuery): Promise<ObservationOverview>
  list(actor: Actor, query: ObservationTaskPageQuery): Promise<ObservationTaskPage>
  detail(actor: Actor, taskId: string): Promise<ObservationTaskDetail | null>
}
