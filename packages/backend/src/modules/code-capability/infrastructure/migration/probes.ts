import type { ReadOnlyProbe } from '@/platform/persistence/migration/run/types'

export const readOnlyProbes: readonly ReadOnlyProbe[] = [
  {
    id: 'code-capability:history-index',
    async run(connection) {
      const rows =
        await connection.query(`SELECT i.source_table, i.original_id FROM code_history_id_index i
      LEFT JOIN code_history_archives a ON a.id = i.archive_id
      WHERE a.id IS NULL OR i.source_table <> a.source_table OR i.source_contract <> a.source_contract
         OR i.record_ordinal < 0 OR i.record_ordinal >= a.row_count`)
      return {
        id: 'code-capability:history-index',
        passed: rows.length === 0,
        detail: { invalidEntries: rows.length },
      }
    },
  },
]
