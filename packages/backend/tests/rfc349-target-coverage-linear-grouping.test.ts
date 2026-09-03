// Locks the second migration stall found by the 4.5GB / 100-client evidence run:
// the daemon's event loop froze **2.8s** during `verifying`, and all 100 status
// clients were dragged to 2.8s with it. The same run at the small seed (two
// orders of magnitude fewer chunks) peaked at 108ms — an O(k²) fingerprint.
//
// The culprit was the copy-receipt grouping inside `assertTargetCoverage`:
//   receiptsByTable.set(tableId, [...current, receipt])
// which rebuilds the array on every receipt, so a table with k chunks costs
// 1+2+…+k element copies. `node_run_events` at the full seed is 10,000,000 rows
// ÷ 1000 rows per chunk = **10,000 chunks** ⇒ ~50 million synchronous copies in
// one uninterrupted loop. bun is single-threaded: that IS the freeze.
//
// This test measures the shape, not the wall clock: it drives the real grouping
// through `finalizeSchema` with a chunk count that would take quadratic time and
// asserts the run stays inside a budget a linear pass meets with room to spare.
import { describe, expect, test } from 'bun:test'

import {
  openPostgresqlLogicalTarget,
  PostgresqlLogicalTargetError,
} from '@/platform/persistence/postgresqlLogicalTarget'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import type {
  LogicalColumnContract,
  LogicalSchemaContract,
  LogicalTableContract,
} from '@/platform/persistence/schemaContract'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'

const CONTRACT_DIGEST = `sha256:${'c'.repeat(64)}`
const CHUNK_ROWS = 1_000
/** 与 full 种子里 `node_run_events` 同量级：1000 万行 ÷ 每片 1000 行。 */
const CHUNKS = 10_000

const ID_COLUMN: LogicalColumnContract = {
  name: 'id',
  logicalCodec: 'text-identity',
  nullable: false,
  primary: true,
  hasDefault: false,
  defaultKind: 'none',
  defaultValue: null,
  providerDefault: { sqlite: null, postgresql: null },
  identity: false,
  uniqueName: null,
  enumValues: [],
  providerType: { sqlite: 'text', postgresql: 'text' },
}

const TABLE: LogicalTableContract = {
  id: 'wide_rows',
  schemaSymbol: 'wideRows',
  ownerContext: 'system-operations',
  disposition: 'KEEP',
  sourceTable: 'wide_rows',
  providerTables: { sqlite: 'wide_rows', postgresql: 'wide_rows' },
  migrationKey: ['id'],
  columns: [ID_COLUMN],
  primaryKey: ['id'],
  unique: [],
  foreignKeys: [],
  checks: [],
  indexes: [],
  retention: { class: 'owner-managed-business', owner: 'system-operations', rule: 'fixture' },
  consumers: {
    productionReader: 'owner-required',
    productionWriter: 'owner-required-or-immutable',
    backgroundRecoveryDiagnostic: 'owner-reviewed',
    evidence: 'fixture',
  },
  rationale: 'fixture',
}

const CONTRACT: LogicalSchemaContract = {
  contractVersion: 2,
  sourceProjection: 'sqlite',
  sourceTableCount: 1,
  activeTableCount: 1,
  archiveOnlyTableCount: 0,
  tables: [TABLE],
  digest: CONTRACT_DIGEST,
}

function rows(values: readonly Record<string, unknown>[]): SqlRows {
  return Object.assign(Promise.resolve(values), {
    async values() {
      return values.map((value) => Object.values(value))
    },
  })
}

const RECEIPTS = Array.from({ length: CHUNKS }, (_unused, index) => ({
  table_id: 'wide_rows',
  chunk_index: index,
  row_count: CHUNK_ROWS,
}))

function runtimeFor(statements: string[]): PostgresqlDatabaseRuntime {
  const connection: PostgresqlReservedConnection = {
    unsafe(sql) {
      statements.push(sql)
      if (sql.includes('pg_try_advisory_lock')) return rows([{ acquired: true }])
      if (sql.includes('pg_advisory_unlock')) return rows([{ released: true }])
      if (sql.startsWith('SELECT table_name FROM information_schema.tables')) {
        return rows([{ table_name: 'wide_rows' }])
      }
      if (sql.includes('FROM "agent_workflow_meta"."schema_migrations"')) return rows([])
      if (sql.includes('SELECT count(*) AS count FROM "agent_workflow"."wide_rows"')) {
        return rows([{ count: CHUNKS * CHUNK_ROWS }])
      }
      if (sql.includes('FROM "agent_workflow_meta"."logical_copy_chunks"')) return rows(RECEIPTS)
      if (sql.includes('SELECT stage FROM "agent_workflow_meta"."logical_copy_operations"')) {
        return rows([{ stage: 'verified' }])
      }
      if (sql.startsWith('UPDATE "agent_workflow_meta"."logical_copy_operations"')) {
        return rows([{ operation_id: 'dbm_linear_0001' }])
      }
      return rows([])
    },
    release() {},
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: connection.unsafe,
    async close() {},
  }
  return {
    provider: 'postgresql',
    generationId: 'dbg_linear_0001',
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    providerPool: () => pool,
    async close() {},
  }
}

describe('RFC-349 target coverage groups copy receipts in linear time', () => {
  test('ten thousand chunks verify without a quadratic regrouping pass', async () => {
    const statements: string[] = []
    const target = await openPostgresqlLogicalTarget({
      runtime: runtimeFor(statements),
      operationId: 'dbm_linear_0001',
      sourceGenerationId: 'dbg_source_0001',
      contract: CONTRACT,
      plan: buildPostgresqlSchemaPlan(CONTRACT),
      verifyMigrationHistory: async () => undefined,
    })
    try {
      const started = performance.now()
      await target.finalizeSchema(10, [
        {
          table: 'wide_rows',
          disposition: 'KEEP',
          rowCount: CHUNKS * CHUNK_ROWS,
          chunkCount: CHUNKS,
        },
      ])
      const elapsedMs = performance.now() - started

      // 微基准（同一形状、1 万个分片、184 张表）：二次方版本 **300ms**，线性版本
      // **0.6ms**——500 倍。预算取 150ms：线性实现连同这条用例里 `finalizeSchema` 的其余
      // 步骤都远远够，二次方实现单是分组就已经越线。
      //
      // 注意这 300ms 只是**同步阻塞**的下界，而且随分片数二次增长：种子再大 4 倍就是
      // 约 4.8 秒。真实迁移里它落在 `verifying`，把 100 个客户端的 status 一起拖住。
      expect(
        elapsedMs,
        `分组回到了 O(k²)：1 万个分片花了 ${elapsedMs.toFixed(0)}ms，` +
          '在真实迁移里这段是 daemon 事件循环被按住的同步时间，且随分片数二次增长',
      ).toBeLessThan(150)
    } finally {
      await target.close()
    }
  })

  test('a receipt for a table outside the roster is still rejected', async () => {
    const statements: string[] = []
    const target = await openPostgresqlLogicalTarget({
      runtime: runtimeFor(statements),
      operationId: 'dbm_linear_0001',
      sourceGenerationId: 'dbg_source_0001',
      contract: { ...CONTRACT, tables: [{ ...TABLE, id: 'other_rows' }] },
      plan: buildPostgresqlSchemaPlan(CONTRACT),
      verifyMigrationHistory: async () => undefined,
    })
    try {
      await expect(
        target.finalizeSchema(10, [
          { table: 'other_rows', disposition: 'KEEP', rowCount: 1, chunkCount: 1 },
        ]),
      ).rejects.toBeInstanceOf(PostgresqlLogicalTargetError)
    } finally {
      await target.close()
    }
  })
})
