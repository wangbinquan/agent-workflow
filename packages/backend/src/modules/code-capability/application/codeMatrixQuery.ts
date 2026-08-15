// RFC-304 T31b — the matrix query, and the work-item projection behind `/code`.
//
// Both read-only, both assembled from tables that already exist. What they add
// is the pairing the page needs: a readiness state next to the specific missing
// piece next to where that piece is configured.

import { and, desc, eq, lt, type SQL } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codeRoundStages, codeWorkItems, codeWorkRounds } from '@/db/schema'
import { listCapabilityCells } from '@/modules/code-capability/infrastructure/sqliteCapabilityMatrix'
import { repairActionsFor } from '@/modules/code-capability/domain/repairActions'
import type {
  CodeMatrixQuery,
  CodeMatrixRow,
  CodeRoundProjection,
  CodeStageProjection,
  CodeWorkItemProjection,
  CodeWorkItemProjectionQuery,
} from '@/modules/code-capability/public/queries'

/** Work items per page. Bounded so one repository cannot return everything. */
export const WORK_ITEM_PAGE_LIMIT = 20

/**
 * How many rounds of each work item are projected.
 *
 * The page shows the state machine's first two levels: the item, and its
 * current round expanded. Older rounds are history — carrying every round of a
 * long-lived MR would make the common request pay for the rare one, and a
 * fifty-round item would dominate a page of twenty.
 */
export const ROUNDS_PER_ITEM = 3

export function createCodeMatrixQuery(db: DbClient): CodeMatrixQuery {
  return {
    async forRepo(repoId) {
      const cells = await listCapabilityCells(db, repoId)
      return cells.map(
        (cell): CodeMatrixRow => ({
          repoId: cell.repoId,
          capability: cell.capability,
          enabled: cell.enabled,
          readiness: cell.readiness,
          issues: cell.readinessIssues,
          // Paired positionally with `issues` — see `repairActionsFor`.
          repairActions: repairActionsFor(cell.readinessIssues),
          bindingId: cell.bindingId,
        }),
      )
    },
  }
}

/**
 * The cursor is the last item's `createdAt` paired with its id.
 *
 * Both, not just the timestamp: work items created in the same millisecond are
 * ordinary under load, and a timestamp-only cursor would either skip the rest
 * of that millisecond or replay it forever.
 */
function encodeCursor(createdAt: number, id: string): string {
  return `${createdAt}:${id}`
}

function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  const cut = cursor.indexOf(':')
  if (cut <= 0) return null
  const createdAt = Number(cursor.slice(0, cut))
  const id = cursor.slice(cut + 1)
  if (!Number.isFinite(createdAt) || id === '') return null
  return { createdAt, id }
}

export function createCodeWorkItemProjectionQuery(db: DbClient): CodeWorkItemProjectionQuery {
  return {
    async page(input) {
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
      if (cursor !== null) {
        // Strictly older than the cursor. An unparsable cursor is ignored rather
        // than erroring: it means a stale link, and starting from the top is a
        // better answer than a page that refuses to render.
        filters.push(lt(codeWorkItems.createdAt, cursor.createdAt))
      }

      const rows = await db
        .select()
        .from(codeWorkItems)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(codeWorkItems.createdAt), desc(codeWorkItems.id))
        // One extra, to learn whether there IS a next page without a second
        // query — and without claiming there is one when the last page is full.
        .limit(limit + 1)

      const page = rows.slice(0, limit)
      const items: CodeWorkItemProjection[] = []
      for (const row of page) {
        items.push({
          workItemId: row.id,
          capability: row.capability,
          anchorKind: row.anchorKind,
          anchorId: row.anchorId,
          status: row.status,
          epoch: row.epoch,
          rounds: await projectRounds(db, row.id),
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

/**
 * A round's status, as a person reads it.
 *
 * The table stores an `outcome` and an end time, not a status: a round in
 * flight has neither. Deriving it here rather than in the page keeps one
 * answer — two UIs deriving it separately would eventually disagree about what
 * a round with an outcome but no end time means.
 *
 * The odd pairing (outcome set, `endedAt` null) is reported as `settling`
 * rather than smoothed to either side: it is the window between recording the
 * verdict and closing the row, and a round stuck there is a real symptom worth
 * seeing rather than hiding behind "running".
 */
export function deriveRoundStatus(outcome: string | null, endedAt: number | null): string {
  if (outcome === null) return endedAt === null ? 'running' : 'ended-without-outcome'
  return endedAt === null ? 'settling' : outcome
}

async function projectRounds(db: DbClient, workItemId: string): Promise<CodeRoundProjection[]> {
  const rounds = await db
    .select()
    .from(codeWorkRounds)
    .where(eq(codeWorkRounds.workItemId, workItemId))
    .orderBy(desc(codeWorkRounds.roundSeq))
    .limit(ROUNDS_PER_ITEM)

  const out: CodeRoundProjection[] = []
  for (const round of rounds) {
    const stages = await db
      .select()
      .from(codeRoundStages)
      // Ascending: the sequence should read the way the engine ran it, which is
      // the opposite of how rounds are listed.
      .orderBy(codeRoundStages.stageSeq)
      .where(eq(codeRoundStages.roundId, round.id))

    out.push({
      roundId: round.id,
      roundSeq: round.roundSeq,
      status: deriveRoundStatus(round.outcome, round.endedAt),
      outcome: round.outcome,
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
  return out
}
