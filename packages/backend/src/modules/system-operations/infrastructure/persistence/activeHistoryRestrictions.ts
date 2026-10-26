import { activeGenerationLineage } from './generationLineage'
import { sql } from 'drizzle-orm'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import {
  historyRestrictionDecision,
  type HistoryRestrictionPort,
  type HistoryRestrictionRecord,
} from '@/platform/contracts/historyRestriction'

/** Read inside the caller's transaction; generation fencing is acquired before owner locks. */
export function createActiveHistoryRestrictionProvider(): HistoryRestrictionPort {
  return {
    async check(tx, request) {
      const provider = engineOf(tx).provider
      const { source: generation } = await activeGenerationLineage(tx)
      if (generation.role === 'installed') return historyRestrictionDecision([])
      if (!generation.run_id) throw new Error('history-restriction-migration-run-missing')
      const table = sql.raw(metaTableName(provider, 'migration_history_restrictions'))
      const rows = await rawRows<Record<string, unknown>>(
        tx,
        sql`SELECT * FROM ${table} WHERE run_id = ${String(generation.run_id)} AND task_id = ${request.taskId} ORDER BY source_table, source_phase, source_key, ordinal`,
      )
      const records: HistoryRestrictionRecord[] = []
      for (const row of rows) {
        const sourceTable = String(row.source_table)
        const gate =
          sourceTable === 'clarify_rounds' || sourceTable === 'collaboration_gate_operations'
        const matches = gate
          ? request.gates.some(
              (item) => item.sourceTable === sourceTable && item.sourceKey === row.source_key,
            )
          : row.node_run_id === null || request.nodeRunIds.includes(String(row.node_run_id))
        if (!matches) continue
        const common = {
          taskId: request.taskId,
          runId: row.node_run_id === null ? null : String(row.node_run_id),
          missingFields: JSON.parse(String(row.missing_fields_json)) as string[],
        }
        const history: HistoryRestrictionRecord['history'] =
          row.execution === 'executable'
            ? {
                ...common,
                execution: 'executable',
                executionUse: 'none',
                reason: String(row.reason) as Extract<
                  HistoryRestrictionRecord['history'],
                  { execution: 'executable' }
                >['reason'],
              }
            : { ...common, execution: row.execution as 'retryable-history' | 'terminal-history' }
        records.push({
          runId: String(row.run_id),
          unitId: String(row.unit_id),
          ordinal: Number(row.ordinal),
          sourceTable,
          sourcePhase: row.source_phase as 'current' | 'pre-upgrade',
          sourceKey: String(row.source_key) as `mk1:${string}`,
          decisionCode: String(row.decision_code),
          history,
        })
      }
      return historyRestrictionDecision(records)
    },
  }
}
