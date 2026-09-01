// RFC-304 T31b — the matrix query, and the work-item projection behind `/code`.
//
// Both read-only, both assembled from tables that already exist. What they add
// is the pairing the page needs: a readiness state next to the specific missing
// piece next to where that piece is configured.

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
import { repairActionsFor } from '@/modules/code-capability/domain/repairActions'
export {
  ROUND_WINDOW,
  ATTEMPT_PAGE,
  VIRTUALISE_THRESHOLD,
} from '@/modules/code-capability/domain/stateViewScale'
import { deriveReadiness } from '@/modules/code-capability/domain/templateLayers'
import type {
  CodeMatrixQuery,
  CodeMatrixRow,
  CodeRoundAttemptsQuery,
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

export function createCodeRoundAttemptsQuery(
  reader: RoundAttemptsReadPort,
): CodeRoundAttemptsQuery {
  return {
    async forRound(roundId) {
      return await reader.load(roundId, ATTEMPTS_PER_ROUND)
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
async function loadCapabilityMatrixRows(
  reader: CapabilityMatrixReadPort,
  repoId: string,
): Promise<readonly CapabilityMatrixReadRow[]> {
  return await reader.loadForRepo(repoId)
}

export function createCodeMatrixQuery(reader: CapabilityMatrixReadPort): CodeMatrixQuery {
  return {
    async forRepo(repoId) {
      const rows = await loadCapabilityMatrixRows(reader, repoId)
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

export function createCodeWorkItemProjectionQuery(
  reader: WorkItemProjectionReadPort,
): CodeWorkItemProjectionQuery {
  return {
    async page(request) {
      return await reader.readPage(request)
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

export function createCodeDeliveryChainQuery(
  reader: DeliveryChainReadPort,
): CodeDeliveryChainQuery {
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
