import type {
  ObservationOverview,
  ObservationOverviewQuery,
  ObservationTaskDetail,
  ObservationTaskPage,
  ObservationTaskPageQuery,
  ObservationTaskSpans,
  ObservationTaskSpansQuery,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'

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
