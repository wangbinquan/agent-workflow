// RFC-304 T31b — the matrix query, and the work-item projection behind `/code`.
//
// Both read-only, both assembled from tables that already exist. What they add
// is the pairing the page needs: a readiness state next to the specific missing
// piece next to where that piece is configured.

import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codeAiAttempts, codeRoundStages, codeWorkItems, codeWorkRounds } from '@/db/schema'
import type {
  DeliveryChainReadPort,
  DeliveryRow,
} from '@/modules/code-capability/application/ports/deliveryChainRead'
import type {
  CapabilityMatrixReadPort,
  CapabilityMatrixReadRow,
} from '@/modules/code-capability/application/ports/capabilityMatrixRead'
import type { RoundAttemptsReadPort } from '@/modules/code-capability/application/ports/roundAttemptsRead'
import type { WorkItemProjectionReadPort } from '@/modules/code-capability/application/ports/workItemProjectionRead'
import { createSqliteDeliveryChainRead } from '@/modules/code-capability/infrastructure/sqliteDeliveryChain'
import { listCapabilityCells } from '@/modules/code-capability/infrastructure/sqliteCapabilityMatrix'
import { gatherReadinessFacts } from '@/modules/code-capability/application/readinessFacts'
import { resolveRepoEndpoint } from '@/modules/code-capability/application/resolveRepoEndpoint'
import { repairActionsFor } from '@/modules/code-capability/domain/repairActions'
export {
  ROUND_WINDOW,
  ATTEMPT_PAGE,
  VIRTUALISE_THRESHOLD,
} from '@/modules/code-capability/domain/stateViewScale'
import { ROUND_WINDOW, roundWindow } from '@/modules/code-capability/domain/stateViewScale'
import { deriveReadiness } from '@/modules/code-capability/domain/templateLayers'
import type {
  CodeMatrixQuery,
  CodeMatrixRow,
  CodeRoundAttemptsQuery,
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

/**
 * How many AI calls one round may return.
 *
 * A fanned-out review of a large diff is one call per shard, times the retries
 * each one took — this bounds the pathological case rather than the ordinary
 * one, which is a handful of rows.
 */
export const ATTEMPTS_PER_ROUND = 200

function isRoundAttemptsReadPort(
  input: DbClient | RoundAttemptsReadPort,
): input is RoundAttemptsReadPort {
  return 'load' in input && typeof input.load === 'function'
}

export function createCodeRoundAttemptsQuery(
  input: DbClient | RoundAttemptsReadPort,
): CodeRoundAttemptsQuery {
  if (isRoundAttemptsReadPort(input)) {
    return {
      async forRound(roundId) {
        return await input.load(roundId, ATTEMPTS_PER_ROUND)
      },
    }
  }
  const db = input
  return {
    async forRound(roundId) {
      return await db
        .select({
          attemptId: codeAiAttempts.id,
          stageName: codeAiAttempts.stageName,
          shardKey: codeAiAttempts.shardKey,
          rerunSeq: codeAiAttempts.rerunSeq,
          attemptSeq: codeAiAttempts.attemptSeq,
          status: codeAiAttempts.status,
          validationOutcome: codeAiAttempts.validationOutcome,
          sessionRef: codeAiAttempts.sessionRef,
          nodeRunId: codeAiAttempts.nodeRunId,
          startedAt: codeAiAttempts.startedAt,
          endedAt: codeAiAttempts.endedAt,
        })
        .from(codeAiAttempts)
        .where(eq(codeAiAttempts.roundId, roundId))
        .orderBy(codeAiAttempts.startedAt, codeAiAttempts.rerunSeq, codeAiAttempts.attemptSeq)
        .limit(ATTEMPTS_PER_ROUND)
    },
  }
}

/**
 * The matrix, with readiness DERIVED at read time rather than read back.
 *
 * The stored `readiness` is written by exactly one path — `enable` — so a cell
 * used to carry whatever was true the last time somebody saved it. Delete the
 * framework a binding points at, make the agent invisible, remove the trigger:
 * the cell went on reading `ready` because nothing had reason to touch it. The
 * person found out when a webhook arrived and nothing happened, which is the
 * worst way to learn it — a `ready` that cannot run stops the search.
 *
 * Deriving on read makes staleness structurally impossible instead of something
 * an invalidation pass has to chase across every mutation path (every route
 * that deletes an agent, a binding, a framework, a trigger — with nothing to
 * catch the one you forget). `domain/readinessInvalidation.ts` was built for
 * that other design and is now redundant; it is left in place rather than
 * deleted so the choice stays reversible.
 *
 * The cost is one fact-gathering pass per cell per read — a handful of indexed
 * lookups for the five capabilities of one repository, on a page a person opens
 * by hand. The stored value stays as the record of what `enable` observed.
 */
function isCapabilityMatrixReadPort(
  input: DbClient | CapabilityMatrixReadPort,
): input is CapabilityMatrixReadPort {
  return 'loadForRepo' in input && typeof input.loadForRepo === 'function'
}

async function loadCapabilityMatrixRows(
  input: DbClient | CapabilityMatrixReadPort,
  repoId: string,
): Promise<readonly CapabilityMatrixReadRow[]> {
  if (isCapabilityMatrixReadPort(input)) return await input.loadForRepo(repoId)

  const db = input
  const cells = await listCapabilityCells(db, repoId)
  if (cells.length === 0) return []

  // Which code host this repository belongs to. A repository whose endpoint
  // cannot be resolved is not an error here: `codeHostConfigured` is one of
  // the facts, and reporting it as missing is the honest answer — the same
  // one the round would reach.
  const endpoint = await resolveRepoEndpoint(db, repoId)
  return await Promise.all(
    cells.map(
      async (cell): Promise<CapabilityMatrixReadRow> => ({
        repoId: cell.repoId,
        capability: cell.capability,
        templateId: cell.templateId,
        enabled: cell.enabled,
        facts: await gatherReadinessFacts({
          db,
          repoId,
          capability: cell.capability,
          endpointId: endpoint.ok ? endpoint.endpointId : '',
          templateId: cell.templateId,
          enabled: cell.enabled,
          ...(endpoint.ok ? { provider: endpoint.provider } : {}),
        }),
      }),
    ),
  )
}

export function createCodeMatrixQuery(input: DbClient | CapabilityMatrixReadPort): CodeMatrixQuery {
  return {
    async forRepo(repoId) {
      const rows = await loadCapabilityMatrixRows(input, repoId)
      return rows.map((row): CodeMatrixRow => {
        const derived = deriveReadiness(row.facts)
        return {
          repoId: row.repoId,
          capability: row.capability,
          enabled: row.enabled,
          readiness: derived.state,
          issues: derived.issues,
          // Paired positionally with `issues` — see `repairActionsFor`.
          repairActions: repairActionsFor(derived.issues),
          templateId: row.templateId,
        }
      })
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
export function encodeCursor(createdAt: number, id: string): string {
  return `${createdAt}:${id}`
}

export function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  const cut = cursor.indexOf(':')
  if (cut <= 0) return null
  const createdAt = Number(cursor.slice(0, cut))
  const id = cursor.slice(cut + 1)
  if (!Number.isFinite(createdAt) || id === '') return null
  return { createdAt, id }
}

function isWorkItemProjectionReadPort(
  input: DbClient | WorkItemProjectionReadPort,
): input is WorkItemProjectionReadPort {
  return 'readPage' in input && typeof input.readPage === 'function'
}

export function createCodeWorkItemProjectionQuery(
  input: DbClient | WorkItemProjectionReadPort,
): CodeWorkItemProjectionQuery {
  if (isWorkItemProjectionReadPort(input)) {
    return {
      async page(request) {
        return await input.readPage(request)
      },
    }
  }
  const db = input
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

      // The caller may widen this to the full window when it is looking at ONE
      // item; the LIST stays narrow, because twenty rounds across twenty items
      // is the response size T66 exists to bound.
      const roundLimit = Math.max(1, Math.min(input.roundLimit ?? ROUNDS_PER_ITEM, ROUND_WINDOW))

      const page = rows.slice(0, limit)
      const items: CodeWorkItemProjection[] = []
      for (const row of page) {
        const projected = await projectRounds(db, row.id, roundLimit)
        items.push({
          workItemId: row.id,
          capability: row.capability,
          anchorKind: row.anchorKind,
          anchorId: row.anchorId,
          status: row.status,
          epoch: row.epoch,
          rounds: projected.rounds,
          // Always present, even at zero: a caller that renders it
          // unconditionally cannot accidentally suppress the notice by reading
          // a missing key as "nothing hidden".
          roundsHidden: projected.hidden,
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

async function projectRounds(
  db: DbClient,
  workItemId: string,
  limit: number,
): Promise<{ rounds: CodeRoundProjection[]; hidden: number }> {
  // The total first, because the count is the point: T66's failure is a
  // truncated list that looks complete, and a reader on an eighty-round merge
  // request seeing three has no way to tell which they are looking at.
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
      // RFC-307 — which contract version this round actually ran.
      //
      // The flow view draws the CURRENT contract, so a round from before a
      // contract bump can name stages the picture does not have. Sending the
      // version lets the UI say "this round ran v3, you are looking at v4"
      // instead of silently dropping the stages it cannot place, which would
      // make an old round look like it skipped work it in fact did.
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

  // `roundWindow` rather than arithmetic here: the page and the query must not
  // be able to disagree about the bound, which is exactly why the constants and
  // the slice live in one domain module.
  const window = roundWindow({ total, limit })
  return { rounds: out, hidden: window.hidden }
}

/**
 * RFC-304 T61 — the delivery chain, readable.
 *
 * The table has been written since T61 (`openDelivery` / `advanceDelivery` are
 * called from the dispatch path) and the three queries over it had NO caller and
 * no route, so nothing could look at it. The migration's own header says why
 * that matters: an administrator reporting "review stopped on this repository"
 * gets `readiness = ready` (the CONFIG is complete, which is not "anything
 * ran") and a last-trigger time (which does not separate "the webhook was never
 * sent" from "it arrived and routing dropped it" from "it is queued behind a
 * merge-request lease"). Each has a different fix, so without this the operator
 * is guessing between three.
 *
 * Three questions, one query object, because they are three filters over one
 * table rather than three features: what happened on this project lately, what
 * happened to THIS delivery (by correlation id, which is the id that follows
 * one event across tables), and what has been failing.
 */
export interface CodeDeliveryChainQuery {
  forProject(input: { stableProjectId: string; limit?: number }): Promise<DeliveryRow[]>
  forCorrelation(correlationId: string): Promise<DeliveryRow[]>
  failures(input: { stableProjectId?: string; limit?: number }): Promise<DeliveryRow[]>
}

function isDeliveryChainReadPort(
  input: DbClient | DeliveryChainReadPort,
): input is DeliveryChainReadPort {
  return 'recent' in input && typeof input.recent === 'function'
}

export function createCodeDeliveryChainQuery(
  input: DbClient | DeliveryChainReadPort,
): CodeDeliveryChainQuery {
  const reader = isDeliveryChainReadPort(input) ? input : createSqliteDeliveryChainRead(input)
  return {
    async forProject(input) {
      return await reader.recent({
        stableProjectId: input.stableProjectId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
    },
    async forCorrelation(correlationId) {
      return await reader.byCorrelation(correlationId)
    },
    async failures(input) {
      return await reader.failures({
        ...(input.stableProjectId === undefined ? {} : { stableProjectId: input.stableProjectId }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
    },
  }
}
