import type { TaskRouteOperations } from '../../public/commands'

export interface TaskReviewersPort {
  get: TaskRouteOperations['getReviewers']
  replace: TaskRouteOperations['replaceReviewers']
}
