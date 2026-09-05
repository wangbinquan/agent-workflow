// RFC-304 T61 — recording where a delivery got to. RFC-359 W4-B5：一份实现，两个 provider 共用。
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

import type { ProviderNeutralDatabase } from '@/db/query'
import { codeTriggerDeliveries } from '@/db/schema'
import type {
  DeliveryChainReadPort,
  DeliveryRow,
} from '@/modules/code-capability/application/ports/deliveryChainRead'
import type { DeliveryOutcome, DeliveryStep } from '@/modules/code-capability/domain/deliveryChain'

/** 查询时再取列：表是按 provider 投影的代理，顶层捕获会钉死在加载时的 provider（见 dev-gotchas）。 */
function fields() {
  return {
    id: codeTriggerDeliveries.id,
    correlationId: codeTriggerDeliveries.correlationId,
    capability: codeTriggerDeliveries.capability,
    step: codeTriggerDeliveries.step,
    outcome: codeTriggerDeliveries.outcome,
    reason: codeTriggerDeliveries.reason,
    queuedAt: codeTriggerDeliveries.queuedAt,
    queuePosition: codeTriggerDeliveries.queuePosition,
    waitingOn: codeTriggerDeliveries.waitingOn,
    roundId: codeTriggerDeliveries.roundId,
    isProbe: codeTriggerDeliveries.isProbe,
    createdAt: codeTriggerDeliveries.createdAt,
    updatedAt: codeTriggerDeliveries.updatedAt,
  }
}

interface DeliveryProjection {
  readonly id: string
  readonly correlationId: string
  readonly capability: string | null
  readonly step: string
  readonly outcome: string
  readonly reason: string | null
  readonly queuedAt: number | null
  readonly queuePosition: number | null
  readonly waitingOn: string | null
  readonly roundId: string | null
  readonly isProbe: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

function toRow(row: DeliveryProjection): DeliveryRow {
  return {
    ...row,
    step: row.step as DeliveryStep,
    outcome: row.outcome as DeliveryOutcome['kind'],
  }
}

export function createDeliveryChainRead(db: ProviderNeutralDatabase): DeliveryChainReadPort {
  return {
    /** Recent deliveries for one project, newest first. */
    async recent(input) {
      const rows = await db
        .select(fields())
        .from(codeTriggerDeliveries)
        .where(eq(codeTriggerDeliveries.stableProjectId, input.stableProjectId))
        .orderBy(desc(codeTriggerDeliveries.createdAt))
        .limit(input.limit ?? 50)
      return rows.map(toRow)
    },
    /** One delivery's whole story, by the id that ties the tables together. */
    async byCorrelation(correlationId) {
      const rows = await db
        .select(fields())
        .from(codeTriggerDeliveries)
        .where(eq(codeTriggerDeliveries.correlationId, correlationId))
        .orderBy(desc(codeTriggerDeliveries.createdAt))
      return rows.map(toRow)
    },
    /** Deliveries that need somebody — failures only, never drops. */
    async failures(input) {
      const filters = [eq(codeTriggerDeliveries.outcome, 'failed')]
      if (input.stableProjectId !== undefined) {
        filters.push(eq(codeTriggerDeliveries.stableProjectId, input.stableProjectId))
      }
      const rows = await db
        .select(fields())
        .from(codeTriggerDeliveries)
        .where(and(...filters))
        .orderBy(desc(codeTriggerDeliveries.createdAt))
        .limit(input.limit ?? 50)
      return rows.map(toRow)
    },
  }
}
