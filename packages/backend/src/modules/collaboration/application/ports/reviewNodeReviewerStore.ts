import type { UserPublic } from '@agent-workflow/shared'

export interface ReviewNodeReviewerAssignmentInput {
  readonly reviewNodeId: string
  readonly reviewerUserId: string
}

export interface ReviewNodeReviewerRow {
  readonly reviewNodeId: string
  readonly user: UserPublic
}

export interface ReviewNodeReviewerStore {
  isAssigned(taskId: string, reviewNodeId: string, userId: string): Promise<boolean>
  listAssignedKeys(reviewerUserId: string, taskIds: readonly string[]): Promise<ReadonlySet<string>>
  listForTask(taskId: string): Promise<ReviewNodeReviewerRow[]>
  activeUserIds(userIds: readonly string[]): Promise<ReadonlySet<string>>
  replaceTask(
    taskId: string,
    assignments: readonly ReviewNodeReviewerAssignmentInput[],
    assignedByUserId: string,
    assignedAt: number,
  ): Promise<void>
}
