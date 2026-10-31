import type { TaskRouteOperations } from '../../public/taskRoutes'

export interface TaskReviewersPort {
  get: TaskRouteOperations['getReviewers']
  replace: TaskRouteOperations['replaceReviewers']
}
