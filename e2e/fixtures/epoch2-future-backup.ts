// Bun child only: a real additive successor in the extracted backup database.
import '../../packages/backend/src/bootstrap/persistenceSchema'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { createRestoreSuccessor } from '../../packages/backend/tests/helpers/rfc395V3/successor'
import { schemaHistoryRuntime } from '../../packages/backend/src/platform/persistence/schema/history/runtime'
import { applyHistoryVersion } from '../../packages/backend/src/platform/persistence/schema/history/apply'
import { sqliteHistorySession } from '../../packages/backend/src/platform/persistence/sqlite/historySession'
import type { HistoryVersion } from '../../packages/backend/src/platform/persistence/schema/history/types'

const root = process.argv[2]
if (!root) throw new Error('epoch2-future-backup requires an extracted backup')
const db = new Database(join(root, 'db.sqlite'), { readwrite: true })
try {
  const row = db
    .query('SELECT artifact_json FROM aw_meta_schema_history ORDER BY version DESC LIMIT 1')
    .get() as { artifact_json: string }
  const previous = JSON.parse(row.artifact_json) as HistoryVersion
  const successor = createRestoreSuccessor(previous, 'ops019_future_probe', 'ops019-future')
  await applyHistoryVersion(sqliteHistorySession(db), {
    version: successor,
    metaTables: schemaHistoryRuntime().metaTables,
  })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
} finally {
  db.close()
}
