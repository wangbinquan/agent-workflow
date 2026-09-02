// RFC-349 T7-D — final target verification is a cutover blocker, and a
// committed schema-finalize transaction must be safe to observe again after a
// process crash before the external operation manifest advances.

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
import {
  buildPostgresqlSchemaPlan,
  type PostgresqlSchemaPlan,
} from '@/platform/persistence/postgresqlSchema'

const CONTRACT_DIGEST = `sha256:${'a'.repeat(64)}`
const PLAN_DIGEST = `sha256:${'b'.repeat(64)}`

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
  id: 'fixture_rows',
  schemaSymbol: 'fixtureRows',
  ownerContext: 'system-operations',
  disposition: 'KEEP',
  sourceTable: 'fixture_rows',
  providerTables: { sqlite: 'fixture_rows', postgresql: 'fixture_rows_pg' },
  migrationKey: ['id'],
  columns: [ID_COLUMN],
  primaryKey: ['id'],
  unique: [],
  foreignKeys: [],
  checks: [],
  indexes: [],
  retention: {
    class: 'owner-managed-business',
    owner: 'system-operations',
    rule: 'fixture',
  },
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

const PLAN: PostgresqlSchemaPlan = {
  version: 1,
  baselineId: '0000_rfc349_baseline_v1',
  contractDigest: CONTRACT_DIGEST,
  activeTableCount: 1,
  archiveOnlyTableCount: 0,
  statements: [
    {
      kind: 'constraint',
      logicalId: 'fixture_rows:check:fixture_check',
      sql: 'ALTER TABLE "agent_workflow"."fixture_rows_pg" ADD CONSTRAINT "fixture_check" CHECK (true)',
    },
  ],
  digest: PLAN_DIGEST,
}

function rows(values: readonly Record<string, unknown>[]): SqlRows {
  return Object.assign(Promise.resolve(values), {
    async values() {
      return values.map((value) => Object.values(value))
    },
  })
}

function fixture(input: {
  readonly rowCount: number
  readonly tableNames?: readonly string[]
  readonly receiptTable?: string
}) {
  const statements: string[] = []
  let baselineCommitted = false
  let stage = 'copying'
  let releases = 0
  const connection: PostgresqlReservedConnection = {
    unsafe(sql) {
      statements.push(sql)
      if (sql.includes('pg_try_advisory_lock')) return rows([{ acquired: true }])
      if (sql.includes('pg_advisory_unlock')) return rows([{ released: true }])
      if (sql.startsWith('SELECT table_name FROM information_schema.tables')) {
        return rows((input.tableNames ?? ['fixture_rows_pg']).map((table_name) => ({ table_name })))
      }
      if (sql.includes('FROM "agent_workflow_meta"."schema_migrations"')) {
        return rows(
          baselineCommitted ? [{ contract_digest: CONTRACT_DIGEST, plan_digest: PLAN_DIGEST }] : [],
        )
      }
      if (sql.includes('SELECT count(*) AS count FROM "agent_workflow"."fixture_rows_pg"')) {
        return rows([{ count: input.rowCount }])
      }
      if (sql.includes('FROM "agent_workflow_meta"."logical_copy_chunks"')) {
        return rows([
          { table_id: input.receiptTable ?? 'fixture_rows', chunk_index: 0, row_count: 2 },
        ])
      }
      if (sql.includes('JOIN "agent_workflow_meta"."logical_copy_operations"')) {
        return rows([{ state: 'active', contract_digest: CONTRACT_DIGEST, stage: 'activated' }])
      }
      if (sql.startsWith('INSERT INTO "agent_workflow_meta"."schema_migrations"')) {
        baselineCommitted = true
        return rows([])
      }
      if (sql.startsWith('UPDATE "agent_workflow_meta"."logical_copy_operations"')) {
        stage = 'verified'
        return rows([{ operation_id: 'dbm_target_0001' }])
      }
      if (sql.includes('SELECT stage FROM "agent_workflow_meta"."logical_copy_operations"')) {
        return rows([{ stage }])
      }
      return rows([])
    },
    release() {
      releases += 1
    },
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: connection.unsafe,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_target_0001',
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
  return {
    runtime,
    statements,
    get releases() {
      return releases
    },
  }
}

const EXPECTED = [
  { table: 'fixture_rows', disposition: 'KEEP' as const, rowCount: 2, chunkCount: 1 },
]

describe('RFC-349 PostgreSQL logical target finalization', () => {
  // 2026-09-02 —— 割接后头一分钟的 40001 风暴。逻辑拷贝是纯 INSERT，不给 PostgreSQL 留
  // 任何 planner 统计；autovacuum 补上之前，`WHERE task_id = $1` 被规划成顺序扫描，而
  // 顺序扫描在 SERIALIZABLE 下持整表 predicate lock，于是每一笔并发写都与它互为读写依赖。
  // 本机取证实测：割接后服务端一分钟内记 3210 次 40001，autoanalyze 之后同样负载几乎归零。
  // ANALYZE 因此是割接的一步，不是优化。
  test('analyzes every active target table once the schema is finalized', async () => {
    const fake = fixture({ rowCount: 2 })
    const target = await openPostgresqlLogicalTarget({
      runtime: fake.runtime,
      operationId: 'dbm_target_0001',
      sourceGenerationId: 'dbg_source_0001',
      contract: CONTRACT,
      plan: PLAN,
      verifyMigrationHistory: async () => undefined,
    })
    try {
      await target.finalizeSchema(10, EXPECTED)
    } finally {
      await target.close()
    }
    const analyze = 'ANALYZE "agent_workflow"."fixture_rows_pg"'
    expect(fake.statements).toContain(analyze)
    // After the DDL transaction: ANALYZE takes its own snapshot, and running it
    // inside would hide the statistics from this operation's own verification.
    expect(fake.statements.indexOf(analyze)).toBeGreaterThan(fake.statements.lastIndexOf('COMMIT'))
  })

  test('re-analyzes on the resume path, where the baseline already exists', async () => {
    const fake = fixture({ rowCount: 2 })
    const target = await openPostgresqlLogicalTarget({
      runtime: fake.runtime,
      operationId: 'dbm_target_0001',
      sourceGenerationId: 'dbg_source_0001',
      contract: CONTRACT,
      plan: PLAN,
      verifyMigrationHistory: async () => undefined,
    })
    try {
      await target.finalizeSchema(10, EXPECTED)
      const first = fake.statements.length
      // Second call takes the already-finalized early return.
      await target.finalizeSchema(11, EXPECTED)
      expect(fake.statements.slice(first)).toContain('ANALYZE "agent_workflow"."fixture_rows_pg"')
    } finally {
      await target.close()
    }
  })

  test('projects the provider-specific physical table mapping', () => {
    const plan = buildPostgresqlSchemaPlan(CONTRACT)
    expect(plan.statements.find((statement) => statement.kind === 'table')?.sql).toContain(
      '"agent_workflow"."fixture_rows_pg"',
    )
  })

  test('blocks schema finalization when final target row coverage differs', async () => {
    const fake = fixture({ rowCount: 3 })
    const target = await openPostgresqlLogicalTarget({
      runtime: fake.runtime,
      operationId: 'dbm_target_0001',
      sourceGenerationId: 'dbg_source_0001',
      contract: CONTRACT,
      plan: PLAN,
      verifyMigrationHistory: async () => undefined,
    })
    try {
      let failure: unknown
      try {
        await target.finalizeSchema(10, EXPECTED)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(PostgresqlLogicalTargetError)
      expect(failure).toMatchObject({ code: 'postgresql-target-verification' })
      expect(fake.statements).toContain('ROLLBACK')
      expect(fake.statements).not.toContain(PLAN.statements[0]!.sql)
    } finally {
      await target.close()
    }
    expect(fake.releases).toBe(1)
  })

  test('blocks finalization when the application schema gains an extra table', async () => {
    const fake = fixture({ rowCount: 2, tableNames: ['fixture_rows_pg', 'legacy_omitted'] })
    const target = await openPostgresqlLogicalTarget({
      runtime: fake.runtime,
      operationId: 'dbm_target_0001',
      sourceGenerationId: 'dbg_source_0001',
      contract: CONTRACT,
      plan: PLAN,
      verifyMigrationHistory: async () => undefined,
    })
    try {
      await expect(target.finalizeSchema(10, EXPECTED)).rejects.toMatchObject({
        code: 'postgresql-target-verification',
      })
      expect(fake.statements).not.toContain(PLAN.statements[0]!.sql)
    } finally {
      await target.close()
    }
  })

  test('blocks finalization when copy receipts name a non-active table', async () => {
    const fake = fixture({ rowCount: 2, receiptTable: 'legacy_omitted' })
    const target = await openPostgresqlLogicalTarget({
      runtime: fake.runtime,
      operationId: 'dbm_target_0001',
      sourceGenerationId: 'dbg_source_0001',
      contract: CONTRACT,
      plan: PLAN,
      verifyMigrationHistory: async () => undefined,
    })
    try {
      await expect(target.finalizeSchema(10, EXPECTED)).rejects.toMatchObject({
        code: 'postgresql-target-verification',
      })
    } finally {
      await target.close()
    }
  })

  test('observes a committed finalization idempotently without replaying DDL', async () => {
    const fake = fixture({ rowCount: 2 })
    const target = await openPostgresqlLogicalTarget({
      runtime: fake.runtime,
      operationId: 'dbm_target_0001',
      sourceGenerationId: 'dbg_source_0001',
      contract: CONTRACT,
      plan: PLAN,
      verifyMigrationHistory: async () => undefined,
    })
    try {
      await target.finalizeSchema(10, EXPECTED)
      await target.finalizeSchema(11, EXPECTED)
      expect(fake.statements.filter((sql) => sql === PLAN.statements[0]!.sql)).toHaveLength(1)
      expect(fake.statements.filter((sql) => sql === 'COMMIT')).toHaveLength(1)
    } finally {
      await target.close()
    }
    expect(fake.releases).toBe(1)
  })

  test('checks cutover readiness on the advisory-lock session', async () => {
    const fake = fixture({ rowCount: 2 })
    const target = await openPostgresqlLogicalTarget({
      runtime: fake.runtime,
      operationId: 'dbm_target_0001',
      sourceGenerationId: 'dbg_source_0001',
      contract: CONTRACT,
      plan: PLAN,
      verifyMigrationHistory: async () => undefined,
    })
    try {
      await target.assertReady('dbg_target_0001')
      expect(fake.statements).toContain(
        'SELECT "id" FROM "agent_workflow"."fixture_rows_pg" ORDER BY "id" LIMIT 1',
      )
    } finally {
      await target.close()
    }
    expect(fake.releases).toBe(1)
  })
})
