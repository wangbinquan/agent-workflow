import type {
  ReplaceReviewNodeReviewersBody,
  ReviewNodeReviewerConfig,
  ReviewSummary,
} from '@agent-workflow/shared'
import type { TaskExecutionReadModels } from '@/modules/task-execution/public/types'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { deriveReviewAccess, type ReviewAccessDecision } from '../domain/reviewAccess'
import type {
  ReviewNodeReviewerAssignmentInput,
  ReviewNodeReviewerStore,
} from './ports/reviewNodeReviewerStore'
import type { ReviewTaskAccessPort } from './ports/reviewTaskAccess'
import type { ReviewActor } from '../public/types'

export interface ReviewNodeReviewerDependencies {
  readonly reviewerStore: ReviewNodeReviewerStore
  readonly taskAccess: ReviewTaskAccessPort
  readonly taskExecutionReadModels: TaskExecutionReadModels
}

async function requireManageableCatalog(
  deps: ReviewNodeReviewerDependencies,
  actor: ReviewActor,
  taskId: string,
) {
  const catalog = await deps.taskExecutionReadModels.taskReviewNodes.find(taskId)
  if (catalog === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  const canManage = deps.taskAccess.canManageReviewers(actor, catalog.taskOwnerUserId)
  if (!canManage) {
    throw new ForbiddenError(
      'forbidden',
      'only the task owner or an actor with resource-acl:bypass can manage review-node reviewers',
    )
  }
  return catalog
}

export async function getReviewNodeReviewerConfig(
  deps: ReviewNodeReviewerDependencies,
  actor: ReviewActor,
  taskId: string,
): Promise<ReviewNodeReviewerConfig> {
  const catalog = await requireManageableCatalog(deps, actor, taskId)
  const rows = await deps.reviewerStore.listForTask(taskId)
  const byNode = new Map<string, typeof rows>()
  for (const row of rows) {
    const list = byNode.get(row.reviewNodeId) ?? []
    list.push(row)
    byNode.set(row.reviewNodeId, list)
  }
  return {
    taskId,
    canManage: true,
    nodes: catalog.nodes.map((node) => ({
      ...node,
      reviewers: (byNode.get(node.reviewNodeId) ?? [])
        .map((row) => row.user)
        .sort(
          (a, b) =>
            a.displayName.localeCompare(b.displayName) || a.username.localeCompare(b.username),
        ),
    })),
  }
}

export async function replaceReviewNodeReviewers(
  deps: ReviewNodeReviewerDependencies,
  actor: ReviewActor,
  taskId: string,
  body: ReplaceReviewNodeReviewersBody,
): Promise<ReviewNodeReviewerConfig> {
  const catalog = await requireManageableCatalog(deps, actor, taskId)
  const knownNodes = new Set(catalog.nodes.map((node) => node.reviewNodeId))
  const seenNodes = new Set<string>()
  const assignments: ReviewNodeReviewerAssignmentInput[] = []
  const allUserIds = new Set<string>()

  for (const node of body.nodes) {
    if (seenNodes.has(node.reviewNodeId)) {
      throw new ValidationError(
        'review-reviewers-duplicate-node',
        `review node '${node.reviewNodeId}' appears more than once`,
      )
    }
    seenNodes.add(node.reviewNodeId)
    if (!knownNodes.has(node.reviewNodeId)) {
      throw new ValidationError(
        'review-reviewers-node-invalid',
        `node '${node.reviewNodeId}' is not a frozen review node of task '${taskId}'`,
      )
    }
    const seenUsers = new Set<string>()
    for (const userId of node.reviewerUserIds) {
      if (seenUsers.has(userId)) {
        throw new ValidationError(
          'review-reviewers-duplicate-user',
          `reviewer '${userId}' appears more than once for node '${node.reviewNodeId}'`,
        )
      }
      seenUsers.add(userId)
      allUserIds.add(userId)
      assignments.push({ reviewNodeId: node.reviewNodeId, reviewerUserId: userId })
    }
  }

  const activeIds = await deps.reviewerStore.activeUserIds([...allUserIds])
  const invalidUserId = [...allUserIds].find((userId) => !activeIds.has(userId))
  if (invalidUserId !== undefined) {
    throw new ValidationError(
      'review-reviewers-user-invalid',
      `reviewer '${invalidUserId}' does not exist or is not active`,
    )
  }

  assignments.sort(
    (a, b) =>
      a.reviewNodeId.localeCompare(b.reviewNodeId) ||
      a.reviewerUserId.localeCompare(b.reviewerUserId),
  )
  deps.reviewerStore.replaceTask(taskId, assignments, actor.user.id, Date.now())
  return getReviewNodeReviewerConfig(deps, actor, taskId)
}

export async function resolveReviewAccess(
  deps: ReviewNodeReviewerDependencies,
  actor: ReviewActor,
  nodeRunId: string,
): Promise<ReviewAccessDecision | null> {
  const subject = await deps.taskExecutionReadModels.reviewGateSubjects.find(nodeRunId)
  if (subject === null) return null
  const [relationship, assignedReviewer] = await Promise.all([
    deps.taskAccess.resolveRelationship(actor, subject.taskId, subject.taskOwnerUserId),
    deps.reviewerStore.isAssigned(subject.taskId, subject.reviewNodeId, actor.user.id),
  ])
  return deriveReviewAccess({
    taskVisible: relationship.taskVisible,
    taskActorRole: relationship.taskActorRole,
    assignedReviewer,
    resourceAclBypass: relationship.resourceAclBypass,
  })
}

export async function filterReviewSummariesForActor<T extends ReviewSummary>(
  deps: ReviewNodeReviewerDependencies,
  actor: ReviewActor,
  rows: readonly T[],
): Promise<Array<T & { accessScope: 'task' | 'review-node' }>> {
  const taskIds = [...new Set(rows.map((row) => row.taskId))]
  if (taskIds.length === 0) return []
  const [visibleTaskIds, assignedKeys] = await Promise.all([
    deps.taskAccess.visibleTaskIds(actor, taskIds),
    deps.reviewerStore.listAssignedKeys(actor.user.id, taskIds),
  ])
  const out: Array<T & { accessScope: 'task' | 'review-node' }> = []
  for (const row of rows) {
    if (visibleTaskIds.has(row.taskId)) {
      out.push({ ...row, accessScope: 'task' })
    } else if (assignedKeys.has(`${row.taskId}\u0000${row.reviewNodeId}`)) {
      out.push({ ...row, accessScope: 'review-node' })
    }
  }
  return out
}
