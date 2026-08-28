import { and, eq, inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { reviewNodeReviewers, users } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import type {
  ReviewNodeReviewerAssignmentInput,
  ReviewNodeReviewerRow,
  ReviewNodeReviewerStore,
} from '../application/ports/reviewNodeReviewerStore'
import type { UserPublic } from '@agent-workflow/shared'

function toUserPublic(row: typeof users.$inferSelect): UserPublic {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
  }
}

export class SqliteReviewNodeReviewerStore implements ReviewNodeReviewerStore {
  constructor(private readonly db: DbClient) {}

  async isAssigned(taskId: string, reviewNodeId: string, userId: string): Promise<boolean> {
    const row = await this.db
      .select({ reviewerUserId: reviewNodeReviewers.reviewerUserId })
      .from(reviewNodeReviewers)
      .where(
        and(
          eq(reviewNodeReviewers.taskId, taskId),
          eq(reviewNodeReviewers.reviewNodeId, reviewNodeId),
          eq(reviewNodeReviewers.reviewerUserId, userId),
        ),
      )
      .limit(1)
    return row.length > 0
  }

  async listAssignedKeys(
    reviewerUserId: string,
    taskIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (taskIds.length === 0) return new Set()
    const rows = await this.db
      .select({
        taskId: reviewNodeReviewers.taskId,
        reviewNodeId: reviewNodeReviewers.reviewNodeId,
      })
      .from(reviewNodeReviewers)
      .where(
        and(
          eq(reviewNodeReviewers.reviewerUserId, reviewerUserId),
          inArray(reviewNodeReviewers.taskId, [...taskIds]),
        ),
      )
    return new Set(rows.map((row) => `${row.taskId}\u0000${row.reviewNodeId}`))
  }

  async listForTask(taskId: string): Promise<ReviewNodeReviewerRow[]> {
    const rows = await this.db
      .select({ reviewNodeId: reviewNodeReviewers.reviewNodeId, user: users })
      .from(reviewNodeReviewers)
      .innerJoin(users, eq(users.id, reviewNodeReviewers.reviewerUserId))
      .where(eq(reviewNodeReviewers.taskId, taskId))
    return rows.map((row) => ({ reviewNodeId: row.reviewNodeId, user: toUserPublic(row.user) }))
  }

  async activeUserIds(userIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (userIds.length === 0) return new Set()
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, [...userIds]), eq(users.status, 'active')))
    return new Set(rows.map((row) => row.id))
  }

  replaceTask(
    taskId: string,
    assignments: readonly ReviewNodeReviewerAssignmentInput[],
    assignedByUserId: string,
    assignedAt: number,
  ): void {
    dbTxSync(this.db, (tx) => {
      tx.delete(reviewNodeReviewers).where(eq(reviewNodeReviewers.taskId, taskId)).run()
      if (assignments.length === 0) return
      tx.insert(reviewNodeReviewers)
        .values(
          assignments.map((assignment) => ({
            taskId,
            reviewNodeId: assignment.reviewNodeId,
            reviewerUserId: assignment.reviewerUserId,
            assignedByUserId,
            assignedAt,
          })),
        )
        .run()
    })
  }
}
