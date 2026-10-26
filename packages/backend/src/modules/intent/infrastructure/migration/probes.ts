import { targetTableName } from '@/platform/persistence/migration/target/loader'
import type { ReadOnlyProbe } from '@/platform/persistence/migration/run/types'
import { decodeIntentApplyRecoveryArtifacts } from '../intentApplyArtifactCodec'

export const readOnlyProbes: readonly ReadOnlyProbe[] = [
  {
    id: 'intent:apply-artifact-envelopes',
    async run(connection) {
      const rows = await connection.query(
        `SELECT id, prepared_artifacts_json FROM ${targetTableName(connection.provider, 'intent_apply_journal')} ORDER BY id`,
      )
      const failures: string[] = []
      for (const row of rows) {
        try {
          decodeIntentApplyRecoveryArtifacts(String(row.prepared_artifacts_json))
        } catch {
          failures.push(String(row.id))
        }
      }
      return {
        id: 'intent:apply-artifact-envelopes',
        passed: failures.length === 0,
        detail: { rows: rows.length, failures },
      }
    },
  },
]
