// RFC-349 — projection for bounded code work-item history. RFC-359 W4-B5：一份实现，两个 provider 共用。

import { and, count, desc, eq, lt, type SQL } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
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

// 查询时再取列：表是按 provider 投影的代理，顶层捕获会钉死在加载时的 provider（见 dev-gotchas）。
function workItemFields() {
  return {
    id: codeWorkItems.id,
    capability: codeWorkItems.capability,
    anchorKind: codeWorkItems.anchorKind,
    anchorId: codeWorkItems.anchorId,
    status: codeWorkItems.status,
    epoch: codeWorkItems.epoch,
    createdAt: codeWorkItems.createdAt,
  }
}

function roundFields() {
  return {
    id: codeWorkRounds.id,
    roundSeq: codeWorkRounds.roundSeq,
    outcome: codeWorkRounds.outcome,
    stageContractVer: codeWorkRounds.stageContractVer,
    baselineSha: codeWorkRounds.baselineSha,
    startedAt: codeWorkRounds.startedAt,
    endedAt: codeWorkRounds.endedAt,
  }
}

function stageFields() {
  return {
    stageName: codeRoundStages.stageName,
    stageSeq: codeRoundStages.stageSeq,
    stageKind: codeRoundStages.stageKind,
    status: codeRoundStages.status,
    error: codeRoundStages.error,
    startedAt: codeRoundStages.startedAt,
    endedAt: codeRoundStages.endedAt,
  }
}

async function projectRounds(
  db: ProviderNeutralDatabase,
  workItemId: string,
  limit: number,
): Promise<{ rounds: CodeRoundProjection[]; hidden: number }> {
  const [counted] = await db
    .select({ n: count() })
    .from(codeWorkRounds)
    .where(eq(codeWorkRounds.workItemId, workItemId))
  const total = counted?.n ?? 0

  const rounds = await db
    .select(roundFields())
    .from(codeWorkRounds)
    .where(eq(codeWorkRounds.workItemId, workItemId))
    .orderBy(desc(codeWorkRounds.roundSeq))
    .limit(limit)

  const projected: CodeRoundProjection[] = []
  for (const round of rounds) {
    const stages = await db
      .select(stageFields())
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

export function createWorkItemProjectionRead(
  db: ProviderNeutralDatabase,
): WorkItemProjectionReadPort {
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
        .select(workItemFields())
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
