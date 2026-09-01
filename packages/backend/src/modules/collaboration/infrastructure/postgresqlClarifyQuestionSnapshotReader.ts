import { and, eq } from 'drizzle-orm'
import { taskQuestions } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  ClarifyQuestionSnapshot,
  ClarifyQuestionSnapshotReader,
} from '../application/ports/clarifyQuestionSnapshotReader'

export class PostgresqlClarifyQuestionSnapshotReader implements ClarifyQuestionSnapshotReader {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async find(
    input: Parameters<ClarifyQuestionSnapshotReader['find']>[0],
  ): Promise<ClarifyQuestionSnapshot | null> {
    const rows = await this.db
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
      .limit(1)
    return rows[0] ?? null
  }
}
