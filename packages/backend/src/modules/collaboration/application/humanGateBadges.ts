// RFC-483 —— the badge use cases' rule (RFC-294 D14). An actor with `tasks:read:all`, or a call without an actor, counts
// every task's gates (the clarify badge then also counts rounds whose task row is gone); everyone else counts the gates of
// the tasks they own or collaborate on, and the review badge adds the review nodes they are assigned to (the read model's
// own condition). The counting itself is the read model's single SQL statement.
import type { CollaborationRouteActor } from './ports/collaborationRouteOperations'
import type { HumanGateBadgeReadModel, HumanGateBadgeViewer } from './ports/humanGateBadgeReadModel'

export type HumanGateBadgeActor = Pick<CollaborationRouteActor, 'user' | 'permissions'>

export function humanGateBadgeViewer(actor?: HumanGateBadgeActor): HumanGateBadgeViewer {
  return actor === undefined || actor.permissions.has('tasks:read:all')
    ? { kind: 'all-tasks' }
    : { kind: 'task-member', userId: actor.user.id }
}

export function countPendingReviewBadge(
  readModel: HumanGateBadgeReadModel,
  actor?: HumanGateBadgeActor,
): Promise<number> {
  return readModel.countPendingReviews(humanGateBadgeViewer(actor))
}

export function countAwaitingClarifyBadge(
  readModel: HumanGateBadgeReadModel,
  actor: HumanGateBadgeActor,
): Promise<number> {
  return readModel.countAwaitingClarifyRounds(humanGateBadgeViewer(actor))
}
