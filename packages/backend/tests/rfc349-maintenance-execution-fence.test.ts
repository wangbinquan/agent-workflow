import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { createSqliteMaintenanceExecutionFence } from '@/platform/persistence/maintenanceExecutionFence'
import { recordStatements } from './helpers/statementRecorder'

describe('RFC-349 maintenance execution fence', () => {
  test('uses the covering node-run status index for the full-scale absence case', async () => {
    const db = createInMemoryDb(resolve(import.meta.dir, '..', 'db', 'migrations'))
    const sqlite = db.$client
    const recording = recordStatements(sqlite)
    try {
      expect(await createSqliteMaintenanceExecutionFence(db)()).toBe('clear')
    } finally {
      recording.stop()
    }

    const statement = recording.selects()[0]
    expect(statement).toBeDefined()
    expect(statement!.sql).toContain('INDEXED BY idx_node_runs_status_active')
    const plan = sqlite
      .query(`EXPLAIN QUERY PLAN ${statement!.sql}`)
      .all(...Array.from({ length: statement!.params }, () => null)) as Array<{
      readonly detail: string
    }>
    expect(plan.map((row) => row.detail).join('\n')).toContain(
      'USING COVERING INDEX idx_node_runs_status_active',
    )

    sqlite.close()
  })
})
