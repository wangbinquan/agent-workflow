// RFC-349 — PostgreSQL delivery-chain read adapter. The application owns the
// troubleshooting questions; this infrastructure adapter owns provider SQL.

import { and, desc, eq } from 'drizzle-orm'

import { codeTriggerDeliveries } from '@/db/schema'
import type {
  DeliveryChainReadPort,
  DeliveryRow,
} from '@/modules/code-capability/application/ports/deliveryChainRead'
import type { DeliveryOutcome, DeliveryStep } from '@/modules/code-capability/domain/deliveryChain'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

const fields = {
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

export function createPostgresqlDeliveryChainRead(
  db: PostgresqlDatabaseClient,
): DeliveryChainReadPort {
  return {
    async recent(input) {
      const rows = await db
        .select(fields)
        .from(codeTriggerDeliveries)
        .where(eq(codeTriggerDeliveries.stableProjectId, input.stableProjectId))
        .orderBy(desc(codeTriggerDeliveries.createdAt))
        .limit(input.limit ?? 50)
      return rows.map(toRow)
    },
    async byCorrelation(correlationId) {
      const rows = await db
        .select(fields)
        .from(codeTriggerDeliveries)
        .where(eq(codeTriggerDeliveries.correlationId, correlationId))
        .orderBy(desc(codeTriggerDeliveries.createdAt))
      return rows.map(toRow)
    },
    async failures(input) {
      const filters = [eq(codeTriggerDeliveries.outcome, 'failed')]
      if (input.stableProjectId !== undefined) {
        filters.push(eq(codeTriggerDeliveries.stableProjectId, input.stableProjectId))
      }
      const rows = await db
        .select(fields)
        .from(codeTriggerDeliveries)
        .where(and(...filters))
        .orderBy(desc(codeTriggerDeliveries.createdAt))
        .limit(input.limit ?? 50)
      return rows.map(toRow)
    },
  }
}
