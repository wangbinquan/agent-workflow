// RFC-395 II-b O3 — the owner retains its existing same-statement candidate DELETE.
import { sql, type AnyColumn, type SQL } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { rawRows } from '@/platform/persistence/queryHelpers'
import type { RetentionSweepPhase } from '@/platform/background/retentionSweepPhase'

/**
 * RFC-565: Task Execution's same-statement fragment — whether the task a row points at is still non-terminal. Bootstrap
 * hands over the owner's implementation (it left the public, which may not carry a database handle or drizzle types).
 */
export type NonTerminalTaskExists = (db: PersistenceDb, taskIdColumn: AnyColumn) => SQL

function webhookFireCandidates(
  db: PersistenceDb,
  cutoff: number | null,
  batchSize: number,
  nonTerminalTaskExists: NonTerminalTaskExists,
): SQL {
  const { webhookTriggerFires } = tablesOf(db)
  return sql`
    SELECT ${webhookTriggerFires.id} AS id
    FROM ${webhookTriggerFires}
    WHERE ${webhookTriggerFires.firedAt} < ${cutoff}
      AND NOT ${nonTerminalTaskExists(db, webhookTriggerFires.taskId)}
    ORDER BY ${webhookTriggerFires.id}
    LIMIT ${batchSize}
  `
}

export function createWebhookFireRetentionPhase(
  db: PersistenceDb,
  nonTerminalTaskExists: NonTerminalTaskExists,
): RetentionSweepPhase {
  return {
    name: 'webhook-trigger-fires',
    counter: 'webhookTriggerFires',
    async deleteBatch(cutoff, batchSize) {
      const { webhookTriggerFires } = tablesOf(db)
      const deleted = await rawRows(
        db,
        databaseSessionFor(db).engine.deleteByCandidates(
          webhookTriggerFires,
          webhookTriggerFires.id,
          webhookFireCandidates(db, cutoff, batchSize, nonTerminalTaskExists),
        ),
      )
      return deleted.length
    },
  }
}
