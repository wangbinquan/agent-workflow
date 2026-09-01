// RFC-333 — SQLite adapter for clarify preparation's exact question snapshot.

import { and, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { taskQuestions } from '@/db/schema'
import type {
  ClarifyQuestionSnapshot,
  ClarifyQuestionSnapshotReader,
} from '../application/ports/clarifyQuestionSnapshotReader'

export class SqliteClarifyQuestionSnapshotReader implements ClarifyQuestionSnapshotReader {
  constructor(private readonly db: DbClient) {}

  async find(
    input: Parameters<ClarifyQuestionSnapshotReader['find']>[0],
  ): Promise<ClarifyQuestionSnapshot | null> {
    return (
      this.db
        .select({
          id: taskQuestions.id,
          taskId: taskQuestions.taskId,
          sourceKind: taskQuestions.sourceKind,
          iteration: taskQuestions.iteration,
          loopIter: taskQuestions.loopIter,
          questionTitle: taskQuestions.questionTitle,
          defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
          createdAt: taskQuestions.createdAt,
          updatedAt: taskQuestions.updatedAt,
        })
        .from(taskQuestions)
        .where(
          and(
            eq(taskQuestions.originNodeRunId, input.originNodeRunId),
            eq(taskQuestions.questionId, input.questionId),
            eq(taskQuestions.roleKind, input.roleKind),
          ),
        )
        .get() ?? null
    )
  }
}
