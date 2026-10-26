import { readDispositionArchives } from '@/platform/persistence/schema/history/dispositionArchive'
import { createTaskClarifyDirectivePersistence } from '@/modules/task-execution/public/participants'
import { readClarifyHistory } from './clarifyHistoryProjection'
import type { TaskArchiveCollaborationSectionReader } from '../application/ports/taskArchiveSections'
import { TASK_ARCHIVE_V3_TABLES } from '@/platform/contracts/taskArchive'
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { chunkedAll } from '@/util/sqlChunk'
import type {
  ArchiveCollaborationSections,
  RecoveryHumanGateFacts,
  NodeRunClarifyNav,
} from '../application/ports/taskCollaborationReads'

export function createTaskArchiveCollaborationSections(
  db: PersistenceDb,
): ArchiveCollaborationSections {
  return {
    sections: Object.keys(TASK_ARCHIVE_V3_TABLES.collaboration),
    async load(taskIds) {
      return (await createTaskArchiveCollaborationSectionReader().load(db, taskIds)).rows
    },
  }
}

export function createTaskRecoveryHumanGateFacts(db: PersistenceDb): RecoveryHumanGateFacts {
  return {
    async designerParkEntries(taskId) {
      const { taskQuestions } = tablesOf(db)
      const { clarifyRounds } = tablesOf(db)
      const projection = {
        dispatchedAt: taskQuestions.dispatchedAt,
        triggerRunId: taskQuestions.triggerRunId,
        defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
        overrideTargetNodeId: taskQuestions.overrideTargetNodeId,
      }
      const clarifyDesigner = await db
        .select(projection)
        .from(taskQuestions)
        .innerJoin(
          clarifyRounds,
          eq(taskQuestions.originNodeRunId, clarifyRounds.intermediaryNodeRunId),
        )
        .where(
          and(
            eq(taskQuestions.taskId, taskId),
            eq(taskQuestions.roleKind, 'designer'),
            ne(taskQuestions.confirmation, 'confirmed'),
            eq(clarifyRounds.status, 'answered'),
            eq(clarifyRounds.directive, 'continue'),
          ),
        )
      const manualDesigner = await db
        .select(projection)
        .from(taskQuestions)
        .where(
          and(
            eq(taskQuestions.taskId, taskId),
            eq(taskQuestions.roleKind, 'designer'),
            eq(taskQuestions.sourceKind, 'manual'),
            ne(taskQuestions.confirmation, 'confirmed'),
          ),
        )
      return [...clarifyDesigner, ...manualDesigner]
    },
    async lifecycleClarifyRounds(taskIds) {
      if (taskIds.length === 0) return []
      const { clarifyRounds } = tablesOf(db)
      return db
        .select({
          taskId: clarifyRounds.taskId,
          id: clarifyRounds.id,
          kind: clarifyRounds.kind,
          status: clarifyRounds.status,
          directive: clarifyRounds.directive,
          clarifyNodeRunId: clarifyRounds.intermediaryNodeRunId,
          clarifyNodeId: clarifyRounds.intermediaryNodeId,
        })
        .from(clarifyRounds)
        .where(inArray(clarifyRounds.taskId, [...taskIds]))
    },
    async hasOpenClarifyRound(taskId) {
      const { clarifyRounds } = tablesOf(db)
      return (
        (await first(
          db
            .select({ id: clarifyRounds.id })
            .from(clarifyRounds)
            .where(
              and(eq(clarifyRounds.taskId, taskId), eq(clarifyRounds.status, 'awaiting_human')),
            )
            .limit(1),
        )) !== undefined
      )
    },
  }
}

export function createTaskNodeRunClarifyNav(db: PersistenceDb): NodeRunClarifyNav {
  return {
    async latestRoundStatusByRun(taskId) {
      const { clarifyRounds } = tablesOf(db)
      const liveRounds = await db
        .select({
          id: clarifyRounds.id,
          intermediaryNodeRunId: clarifyRounds.intermediaryNodeRunId,
          status: clarifyRounds.status,
          createdAt: clarifyRounds.createdAt,
        })
        .from(clarifyRounds)
        .where(eq(clarifyRounds.taskId, taskId))
      const history = await readClarifyHistory(db, { taskId })
      const rounds = [
        ...liveRounds,
        ...history.filter((old) => !liveRounds.some((row) => row.id === old.id)),
      ]
      // 同 createdAt 保持原查询先见行，不增加排序或 id tie-break。
      const latestRoundByRun = new Map<string, (typeof rounds)[number]>()
      for (const round of rounds) {
        const previous = latestRoundByRun.get(round.intermediaryNodeRunId)
        if (previous === undefined || previous.createdAt < round.createdAt) {
          latestRoundByRun.set(round.intermediaryNodeRunId, round)
        }
      }
      return new Map([...latestRoundByRun].map(([id, round]) => [id, round.status]))
    },
  }
}

export function createTaskArchiveCollaborationSectionReader(): TaskArchiveCollaborationSectionReader {
  return {
    async load(tx, taskIds) {
      const directives = createTaskClarifyDirectivePersistence(tx)
      const {
        taskCollaborators,
        reviewNodeReviewers,
        taskQuestions,
        taskFeedback,
        collaborationGateOperations,
      } = tablesOf(tx)
      const {
        clarifyRounds,
        clarifyAnswers,
        clarifyAnswerDrafts,
        clarifyAnswerAttributions,
        collaborationGateArtifacts,
        docVersions,
        reviewComments,
      } = tablesOf(tx)
      const rounds = await chunkedAll(taskIds, (ids) =>
        tx.select().from(clarifyRounds).where(inArray(clarifyRounds.taskId, ids)),
      )
      const roundIds = rounds.map((row) => row.id)
      const operations = await chunkedAll(taskIds, (ids) =>
        tx
          .select()
          .from(collaborationGateOperations)
          .where(inArray(collaborationGateOperations.taskId, ids)),
      )
      const docs = await chunkedAll(taskIds, (ids) =>
        tx.select().from(docVersions).where(inArray(docVersions.taskId, ids)),
      )
      return {
        owner: 'C',
        dispositionEvidence: (await readDispositionArchives(tx, 'clarify_rounds')).filter((row) =>
          taskIds.includes(String(row.values.task_id)),
        ),
        rows: {
          task_collaborators: await chunkedAll(taskIds, (ids) =>
            tx.select().from(taskCollaborators).where(inArray(taskCollaborators.taskId, ids)),
          ),
          review_node_reviewers: await chunkedAll(taskIds, (ids) =>
            tx.select().from(reviewNodeReviewers).where(inArray(reviewNodeReviewers.taskId, ids)),
          ),
          task_questions: await chunkedAll(taskIds, (ids) =>
            tx.select().from(taskQuestions).where(inArray(taskQuestions.taskId, ids)),
          ),
          task_feedback: await chunkedAll(taskIds, (ids) =>
            tx.select().from(taskFeedback).where(inArray(taskFeedback.taskId, ids)),
          ),
          task_node_clarify_directives: await chunkedAll(taskIds, (ids) =>
            directives.archiveRows(ids),
          ),
          clarify_rounds: rounds,
          clarify_answers: await chunkedAll(roundIds, (ids) =>
            tx.select().from(clarifyAnswers).where(inArray(clarifyAnswers.roundId, ids)),
          ),
          clarify_answer_drafts: await chunkedAll(roundIds, (ids) =>
            tx.select().from(clarifyAnswerDrafts).where(inArray(clarifyAnswerDrafts.roundId, ids)),
          ),
          clarify_answer_attributions: await chunkedAll(roundIds, (ids) =>
            tx
              .select()
              .from(clarifyAnswerAttributions)
              .where(inArray(clarifyAnswerAttributions.roundId, ids)),
          ),
          collaboration_gate_operations: operations,
          collaboration_gate_artifacts: await chunkedAll(
            operations.map((row) => row.id),
            (ids) =>
              tx
                .select()
                .from(collaborationGateArtifacts)
                .where(inArray(collaborationGateArtifacts.operationId, ids)),
          ),
          doc_versions: docs,
          review_comments: await chunkedAll(
            docs.map((row) => row.id),
            (ids) =>
              tx.select().from(reviewComments).where(inArray(reviewComments.docVersionId, ids)),
          ),
        },
      }
    },
  }
}
