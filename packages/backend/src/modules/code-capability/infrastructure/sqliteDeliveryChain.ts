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
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { codeTriggerDeliveries } from '@/db/schema'
import type {
  DeliveryOutcome,
  DeliveryStep,
  QueueDetail,
} from '@/modules/code-capability/domain/deliveryChain'

export interface OpenDeliveryArgs {
  db: DbClient
  correlationId: string
  codeHostEndpointId?: string | null
  stableProjectId?: string | null
  anchorKind?: string | null
  anchorId?: string | null
  isProbe?: boolean
  now?: number
}

/** Start the record at `received`; every later step advances this row. */
export async function openDelivery(args: OpenDeliveryArgs): Promise<{ id: string }> {
  const now = args.now ?? Date.now()
  const id = ulid()
  await args.db.insert(codeTriggerDeliveries).values({
    id,
    correlationId: args.correlationId,
    codeHostEndpointId: args.codeHostEndpointId ?? null,
    stableProjectId: args.stableProjectId ?? null,
    anchorKind: args.anchorKind ?? null,
    anchorId: args.anchorId ?? null,
    capability: null,
    step: 'received' satisfies DeliveryStep,
    outcome: 'ok',
    reason: null,
    isProbe: args.isProbe ?? false,
    createdAt: now,
    updatedAt: now,
  })
  return { id }
}

export interface AdvanceArgs {
  db: DbClient
  deliveryId: string
  step: DeliveryStep
  outcome: DeliveryOutcome['kind']
  reason?: string | null
  capability?: string | null
  roundId?: string | null
  queue?: QueueDetail | null
  now?: number
}

/**
 * Move a delivery to its next step.
 *
 * Deliberately not a no-op when the outcome is already terminal: a delivery
 * that failed and is then retried genuinely moves forward, and refusing the
 * write would leave the row claiming a failure that no longer describes it.
 */
export async function advanceDelivery(args: AdvanceArgs): Promise<void> {
  const now = args.now ?? Date.now()
  await args.db
    .update(codeTriggerDeliveries)
    .set({
      step: args.step,
      outcome: args.outcome,
      reason: args.reason ?? null,
      ...(args.capability === undefined ? {} : { capability: args.capability }),
      ...(args.roundId === undefined ? {} : { roundId: args.roundId }),
      // Queue detail is cleared when leaving the queue, so a delivered row does
      // not still advertise the position it waited in.
      queuedAt: args.queue?.ageMs === undefined ? null : now - args.queue.ageMs,
      queuePosition: args.queue?.position ?? null,
      waitingOn: args.queue?.waitingOn ?? null,
      updatedAt: now,
    })
    .where(eq(codeTriggerDeliveries.id, args.deliveryId))
}

export interface DeliveryRow {
  id: string
  correlationId: string
  capability: string | null
  step: DeliveryStep
  outcome: DeliveryOutcome['kind']
  reason: string | null
  queuedAt: number | null
  queuePosition: number | null
  waitingOn: string | null
  roundId: string | null
  isProbe: boolean
  createdAt: number
  updatedAt: number
}

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
