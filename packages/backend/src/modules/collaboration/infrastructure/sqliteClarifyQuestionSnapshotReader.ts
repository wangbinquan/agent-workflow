// RFC-333 — SQLite adapter for clarify preparation's exact question snapshot.

import { and, eq } from 'drizzle-orm'
import { taskQuestions } from '@/db/schema'
import type {
  ClarifyQuestionSnapshot,
  ClarifyQuestionSnapshotReader,
} from '../application/ports/clarifyQuestionSnapshotReader'

export class SqliteClarifyQuestionSnapshotReader implements ClarifyQuestionSnapshotReader {
  findTx(
    input: Parameters<ClarifyQuestionSnapshotReader['findTx']>[0],
  ): ClarifyQuestionSnapshot | null {
    return (
      input.tx
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
