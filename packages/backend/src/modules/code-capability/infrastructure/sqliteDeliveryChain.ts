// RFC-304 T61 — recording where a delivery got to.
//
// One row per delivery, ADVANCED in place rather than one row per step. Two
// reasons, and the second is the one that decided it:
//
//   a step-per-row table answers "what happened" but makes "what is stuck right
//   now" a group-by over the whole history — the query an administrator runs
//   when something is wrong is the one that would be slowest;
//
//   and the interesting fact is almost always the LAST step, not the path. A
//   delivery that reached `published` has an uninteresting history; one stuck
//   at `queued` has an uninteresting history too. The path only matters when
//   somebody is debugging the platform itself, and the correlation id already
//   ties the round and stage tables to it for that case.

import { and, desc, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codeTriggerDeliveries } from '@/db/schema'
import type {
  DeliveryChainReadPort,
  DeliveryRow,
} from '@/modules/code-capability/application/ports/deliveryChainRead'
import type { DeliveryOutcome, DeliveryStep } from '@/modules/code-capability/domain/deliveryChain'

/** Recent deliveries for one project, newest first. */
export async function recentDeliveries(input: {
  db: DbClient
  stableProjectId: string
  limit?: number
}): Promise<DeliveryRow[]> {
  const rows = await input.db
    .select()
    .from(codeTriggerDeliveries)
    .where(eq(codeTriggerDeliveries.stableProjectId, input.stableProjectId))
    .orderBy(desc(codeTriggerDeliveries.createdAt))
    .limit(input.limit ?? 50)
  return rows.map(toRow)
}

/** One delivery's whole story, by the id that ties the tables together. */
export async function deliveriesByCorrelation(input: {
  db: DbClient
  correlationId: string
}): Promise<DeliveryRow[]> {
  const rows = await input.db
    .select()
    .from(codeTriggerDeliveries)
    .where(eq(codeTriggerDeliveries.correlationId, input.correlationId))
    .orderBy(desc(codeTriggerDeliveries.createdAt))
  return rows.map(toRow)
}

/** Deliveries that need somebody — failures only, never drops. */
export async function failedDeliveries(input: {
  db: DbClient
  stableProjectId?: string
  limit?: number
}): Promise<DeliveryRow[]> {
  const filters = [eq(codeTriggerDeliveries.outcome, 'failed')]
  if (input.stableProjectId !== undefined) {
    filters.push(eq(codeTriggerDeliveries.stableProjectId, input.stableProjectId))
  }
  const rows = await input.db
    .select()
    .from(codeTriggerDeliveries)
    .where(and(...filters))
    .orderBy(desc(codeTriggerDeliveries.createdAt))
    .limit(input.limit ?? 50)
  return rows.map(toRow)
}

export function createSqliteDeliveryChainRead(db: DbClient): DeliveryChainReadPort {
  return {
    async recent(input) {
      return await recentDeliveries({ db, ...input })
    },
    async byCorrelation(correlationId) {
      return await deliveriesByCorrelation({ db, correlationId })
    },
    async failures(input) {
      return await failedDeliveries({ db, ...input })
    },
  }
}

function toRow(row: typeof codeTriggerDeliveries.$inferSelect): DeliveryRow {
  return {
    id: row.id,
    correlationId: row.correlationId,
    capability: row.capability,
    step: row.step as DeliveryStep,
    outcome: row.outcome as DeliveryOutcome['kind'],
    reason: row.reason,
    queuedAt: row.queuedAt,
    queuePosition: row.queuePosition,
    waitingOn: row.waitingOn,
    roundId: row.roundId,
    isProbe: row.isProbe,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
