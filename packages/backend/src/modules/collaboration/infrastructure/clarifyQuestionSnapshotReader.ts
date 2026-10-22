// RFC-359 W4-D25 —— clarify 准备用的问题快照读面：一份实现，两个引擎共用。
// 合一前两份逐字同一条查询，只差取行姿势（SQLite `.get()` / PG `.limit(1)` 取首行）。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  ClarifyQuestionSnapshot,
  ClarifyQuestionSnapshotReader,
} from '../application/ports/clarifyQuestionSnapshotReader'

export class DatabaseClarifyQuestionSnapshotReader implements ClarifyQuestionSnapshotReader {
  constructor(private readonly db: PersistenceDb) {}

  async find(
    input: Parameters<ClarifyQuestionSnapshotReader['find']>[0],
  ): Promise<ClarifyQuestionSnapshot | null> {
    const { taskQuestions } = tablesOf(this.db)
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
