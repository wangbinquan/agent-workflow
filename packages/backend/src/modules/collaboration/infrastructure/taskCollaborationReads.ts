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
    sections: ['clarify_rounds'],
    async load(taskIds) {
      return {
        clarify_rounds: await chunkedAll(taskIds, async (ids) => {
          const { clarifyRounds } = tablesOf(db)
          return db.select().from(clarifyRounds).where(inArray(clarifyRounds.taskId, ids))
        }),
      }
    },
  }
}

export function createTaskRecoveryHumanGateFacts(db: PersistenceDb): RecoveryHumanGateFacts {
  return {
    async designerParkEntries(taskId) {
      const { taskQuestions, clarifyRounds } = tablesOf(db)
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
      const rounds = await db
        .select({
          intermediaryNodeRunId: clarifyRounds.intermediaryNodeRunId,
          status: clarifyRounds.status,
          createdAt: clarifyRounds.createdAt,
        })
        .from(clarifyRounds)
        .where(eq(clarifyRounds.taskId, taskId))
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
