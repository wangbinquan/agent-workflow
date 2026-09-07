// RFC-359 W11：围栏的两份实现（SQLite 裸 raw SQL + PostgreSQL 查询构造器）已合成一份，
// 索引提示由能力矩阵按引擎渲染。本文件的判据一字未变，只是锚点跟着实现走：这里继续用**真的
// 迁移目录**建库，钉住「SQLite 侧仍然走覆盖索引」这一条；行为面（clear / busy、两个引擎上
// 语句都合法）由 `rfc359-w11-dialect-ledger-conformance.test.ts` 在两个引擎上各跑一遍。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { createMaintenanceExecutionFence } from '@/platform/persistence/maintenanceExecutionFence'
import { recordStatements } from './helpers/statementRecorder'

describe('RFC-349 maintenance execution fence', () => {
  test('uses the covering node-run status index for the full-scale absence case', async () => {
    const db = createInMemoryDb(resolve(import.meta.dir, '..', 'db', 'migrations'))
    const sqlite = db.$client
    const recording = recordStatements(sqlite)
    try {
      expect(await createMaintenanceExecutionFence(db)()).toBe('clear')
    } finally {
      recording.stop()
    }

    const statement = recording.selects()[0]
    expect(statement).toBeDefined()
    // 索引名现在由 `sql.identifier` 引起来（矩阵的渲染），提示本身一字未变。
    expect(statement!.sql).toContain('INDEXED BY "idx_node_runs_status_active"')
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
