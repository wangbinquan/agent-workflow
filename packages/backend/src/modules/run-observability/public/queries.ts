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
