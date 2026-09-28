import type {
  ObservationOverview,
  ObservationOverviewQuery,
  ObservationTaskDetail,
  ObservationTaskPage,
  ObservationTaskPageQuery,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'

export interface ObservationTaskQueries {
  overview(actor: Actor, query: ObservationOverviewQuery): Promise<ObservationOverview>
  list(actor: Actor, query: ObservationTaskPageQuery): Promise<ObservationTaskPage>
  detail(actor: Actor, taskId: string): Promise<ObservationTaskDetail | null>
}
