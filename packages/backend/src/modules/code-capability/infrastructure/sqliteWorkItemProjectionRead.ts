// RFC-349 — SQLite projection for bounded code work-item history.

import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codeRoundStages, codeWorkItems, codeWorkRounds } from '@/db/schema'
import {
  decodeCursor,
  deriveRoundStatus,
  encodeCursor,
  ROUNDS_PER_ITEM,
  WORK_ITEM_PAGE_LIMIT,
} from '../application/codeMatrixQuery'
import type { WorkItemProjectionReadPort } from '../application/ports/workItemProjectionRead'
import { ROUND_WINDOW, roundWindow } from '../domain/stateViewScale'
import type {
  CodeRoundProjection,
  CodeStageProjection,
  CodeWorkItemProjection,
} from '../public/queries'

async function projectRounds(
  db: DbClient,
  workItemId: string,
  limit: number,
): Promise<{ rounds: CodeRoundProjection[]; hidden: number }> {
  const [counted] = await db
    .select({ n: sql<number>`count(*)` })
    .from(codeWorkRounds)
    .where(eq(codeWorkRounds.workItemId, workItemId))
  const total = counted?.n ?? 0

  const rounds = await db
    .select()
    .from(codeWorkRounds)
    .where(eq(codeWorkRounds.workItemId, workItemId))
    .orderBy(desc(codeWorkRounds.roundSeq))
    .limit(limit)

  const projected: CodeRoundProjection[] = []
  for (const round of rounds) {
    const stages = await db
      .select()
      .from(codeRoundStages)
      .orderBy(codeRoundStages.stageSeq)
      .where(eq(codeRoundStages.roundId, round.id))
    projected.push({
      roundId: round.id,
      roundSeq: round.roundSeq,
      status: deriveRoundStatus(round.outcome, round.endedAt),
      outcome: round.outcome,
      stageContractVer: round.stageContractVer,
      baselineSha: round.baselineSha,
      startedAt: round.startedAt,
      endedAt: round.endedAt,
      stages: stages.map(
        (stage): CodeStageProjection => ({
          stageName: stage.stageName,
          stageSeq: stage.stageSeq,
          kind: stage.stageKind,
          status: stage.status,
          error: stage.error,
          startedAt: stage.startedAt,
          endedAt: stage.endedAt,
        }),
      ),
    })
  }

  return { rounds: projected, hidden: roundWindow({ total, limit }).hidden }
}

export function createSqliteWorkItemProjectionRead(db: DbClient): WorkItemProjectionReadPort {
  return {
    async readPage(input) {
      const limit = Math.max(1, Math.min(input.limit ?? WORK_ITEM_PAGE_LIMIT, 100))
      const filters: SQL[] = []
      if (input.codeHostEndpointId !== undefined) {
        filters.push(eq(codeWorkItems.codeHostEndpointId, input.codeHostEndpointId))
      }
      if (input.stableProjectId !== undefined) {
        filters.push(eq(codeWorkItems.stableProjectId, input.stableProjectId))
      }
      if (input.capability !== undefined) {
        filters.push(eq(codeWorkItems.capability, input.capability))
      }
      const cursor = input.cursor == null ? null : decodeCursor(input.cursor)
      if (cursor !== null) filters.push(lt(codeWorkItems.createdAt, cursor.createdAt))

      const rows = await db
        .select()
        .from(codeWorkItems)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(codeWorkItems.createdAt), desc(codeWorkItems.id))
        .limit(limit + 1)
      const roundLimit = Math.max(1, Math.min(input.roundLimit ?? ROUNDS_PER_ITEM, ROUND_WINDOW))

      const page = rows.slice(0, limit)
      const items: CodeWorkItemProjection[] = []
      for (const row of page) {
        const rounds = await projectRounds(db, row.id, roundLimit)
        items.push({
          workItemId: row.id,
          capability: row.capability,
          anchorKind: row.anchorKind,
          anchorId: row.anchorId,
          status: row.status,
          epoch: row.epoch,
          rounds: rounds.rounds,
          roundsHidden: rounds.hidden,
        })
      }

      const last = page.at(-1)
      return {
        items,
        nextCursor:
          rows.length > limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
      }
    },
  }
}
