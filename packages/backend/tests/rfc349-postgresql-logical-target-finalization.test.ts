// RFC-349 T7-D — final target verification is a cutover blocker, and a
// committed schema-finalize transaction must be safe to observe again after a
// process crash before the external operation manifest advances.

import { withNativeTransactions } from './helpers/nativeTransactions'
import { buildFrozenEpoch1LogicalSchemaContract } from '@/platform/persistence/migration/epoch1/contract'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import { setDefaultTimeout, describe, expect, test } from 'bun:test'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { describeV3Providers, type V3Harness } from './helpers/rfc395V3Harness'
import {
  createLogicalTableChunk,
  encodeLogicalRow,
} from '@/platform/persistence/logicalDatabaseArtifact'
import {
  openPostgresqlLogicalTarget,
  PostgresqlLogicalTargetError,
} from '@/platform/persistence/postgresqlLogicalTarget'
import { openPostgresqlLogicalTarget as openFrozenPostgresqlLogicalTarget } from '@/platform/persistence/migration/legacy/postgresqlLogicalTarget'
import type {
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
import type { PostgresqlSchemaPlan as FrozenPostgresqlSchemaPlan } from '@/platform/persistence/migration/legacy/postgresqlSchema'
import { OBSERVATION_SOURCE_REVISION } from '@/platform/persistence/observationSourceRevisionSchema'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/migration/legacy/postgresqlMigrationHistory'

// Native target installation and logical-copy finalization take about 5 s per CI-scaled case; allow 20 s.
setDefaultTimeout(20000)

/**
 * RFC-371 v2 retired every native observation statement from the current plan. The
 * published plan just before 0032 still carries source-revision initializers and
 * retained-revision functions/triggers, so it exercises the same logical-target mechanism.
 */
async function nativeRevisionPlan(): Promise<FrozenPostgresqlSchemaPlan> {
  const history = await loadPostgresqlMigrationHistory({
    headContract: buildFrozenEpoch1LogicalSchemaContract(),
  })
  const index = history.steps.findIndex((step) => step.id === '0032_rfc371_observation_v2')
  if (index < 0) throw new Error('published 0032 step missing')
  return history.versions[index]!.plan
}

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

const PLAN: FrozenPostgresqlSchemaPlan = {
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

function frozenFixture(input: {
  readonly rowCount: number
  readonly tableNames?: readonly string[]
  readonly receiptTable?: string
}) {
  const statements: string[] = []
  let baselineCommitted = false
  let stage = 'copying'
  let releases = 0
  const connection: PostgresqlReservedConnection = withNativeTransactions({
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
  })
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: connection.unsafe,
    async close() {},
  }
  const runtime = createPostgresqlDatabaseRuntime({
    config: PostgresqlDatabaseConfigSchema.parse({
      provider: 'postgresql',
      urlEnv: 'FROZEN_PROTOCOL_URL',
    }),
    generationId: 'dbg_target_0001',
    env: { FROZEN_PROTOCOL_URL: 'postgresql://localhost/frozen_protocol' },
    poolFactory: () => pool,
  })
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

// BF-D29: these two cases require the published pre-0032 observation/retained
// revision protocol as converter input. Epoch 2 never installs that protocol.
describe('RFC-349 frozen epoch-1 converter-input finalization', () => {
  test('logical copy keeps source revisions empty for exact copied values while preserving ordinary metadata', async () => {
    const fake = frozenFixture({ rowCount: 0, tableNames: [] })
    const sourceInitializer = (await nativeRevisionPlan()).statements.find(
      (statement) => statement.logicalId === 'observation_source_revisions:initial-revisions',
    )!
    expect(sourceInitializer.sql).toContain("('agents',gen_random_uuid()::text)")
    expect(sourceInitializer.sql).toContain("('users',gen_random_uuid()::text)")
    const ordinary = {
      kind: 'metadata' as const,
      logicalId: 'ordinary-copy-metadata',
      sql: 'CREATE TABLE "agent_workflow_meta"."ordinary_copy_fixture" (id text)',
    }
    const table = { ...TABLE, sourceRevisionProjection: OBSERVATION_SOURCE_REVISION }
    const target = await openFrozenPostgresqlLogicalTarget({
      headContract: buildFrozenEpoch1LogicalSchemaContract(),
      runtime: fake.runtime,
      operationId: 'dbm_target_0001',
      sourceGenerationId: 'dbg_source_0001',
      contract: { ...CONTRACT, tables: [{ ...table, id: 'observation_source_revisions' }] },
      plan: { ...PLAN, statements: [ordinary, sourceInitializer] },
      verifyMigrationHistory: async () => undefined,
    })
    try {
      await target.prepare(9)
      expect(fake.statements).toContain(ordinary.sql)
      expect(fake.statements).not.toContain(sourceInitializer.sql)
      expect(
        fake.statements.some((statement) =>
          statement.startsWith('INSERT INTO "agent_workflow_meta"."logical_copy_operations"'),
        ),
      ).toBe(true)
    } finally {
      await target.close()
    }
  })

  test('retained revision native functions and triggers install after copied rows and constraints, before verified receipt', async () => {
    const copiedTables: string[] = []
    const fake = frozenFixture({ rowCount: 2, tableNames: copiedTables })
    const native = (await nativeRevisionPlan()).statements.filter(
      (statement) =>
        (statement.kind === 'function' || statement.kind === 'trigger') &&
        !statement.logicalId.startsWith('observation_source_revisions:') &&
        !statement.logicalId.includes(':observation-source:') &&
        !statement.logicalId.startsWith('observation_projection_changes:') &&
        !statement.logicalId.endsWith(':observation-change'),
    )
    expect(native.filter((statement) => statement.kind === 'function')).toHaveLength(3)
    expect(native.filter((statement) => statement.kind === 'trigger')).toHaveLength(12)
    const target = await openFrozenPostgresqlLogicalTarget({
      headContract: buildFrozenEpoch1LogicalSchemaContract(),
      runtime: fake.runtime,
      operationId: 'dbm_target_0001',
      sourceGenerationId: 'dbg_source_0001',
      contract: CONTRACT,
      plan: { ...PLAN, statements: [...PLAN.statements, ...native] },
      verifyMigrationHistory: async () => undefined,
    })
    try {
      await target.prepare(9)
      expect(
        fake.statements.some((statement) => native.some((item) => item.sql === statement)),
      ).toBe(false)
      copiedTables.push('fixture_rows_pg')
      await target.finalizeSchema(10, EXPECTED)
      const constraint = fake.statements.indexOf(PLAN.statements[0]!.sql)
      const receipt = fake.statements.findIndex((statement) =>
        statement.startsWith('INSERT INTO "agent_workflow_meta"."schema_migrations"'),
      )
      for (const statement of native) {
        expect(fake.statements.indexOf(statement.sql)).toBeGreaterThan(constraint)
        expect(fake.statements.indexOf(statement.sql)).toBeLessThan(receipt)
      }
    } finally {
      await target.close()
    }
  })
})

const LIVE_PLAN = buildPostgresqlSchemaPlan(logicalSchemaContract)
const LIVE_TABLE = logicalSchemaContract.tables.find((table) => table.id === 'maintenance_state')!
const LIVE_EXPECTED = logicalSchemaContract.tables.map((table) => ({
  table: table.id,
  disposition: table.disposition,
  rowCount: table.id === LIVE_TABLE.id ? 2 : 0,
  chunkCount: table.id === LIVE_TABLE.id ? 1 : 0,
}))
const LIVE_FOREIGN_KEYS = LIVE_PLAN.statements.filter(
  (statement) => statement.kind === 'constraint' && statement.logicalId.includes(':fk:'),
)

async function liveFixture(
  h: V3Harness,
  input: {
    rowCount?: number
    extraTable?: boolean
    receiptTable?: string
    active?: boolean
    stage?: 'prepared' | 'activated'
  } = {},
) {
  await h.target.execute('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
  await h.target.execute('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
  const statements: string[] = []
  let releases = 0,
    reservations = 0
  const pool = h.runtime.providerPool()
  // Native recording adapter: every SQL call goes to the real harness database.
  // The original runtime/pool is frozen; do not monkey-patch its methods.
  const recordedPool: PostgresqlPool = {
    async reserve(options) {
      reservations += 1
      const connection = await pool.reserve(options)
      return {
        begin: (body) => connection.begin(body),
        unsafe(sql, values) {
          statements.push(sql)
          return connection.unsafe(sql, values)
        },
        release() {
          releases += 1
          connection.release()
        },
      }
    },
    unsafe: (sql, values) => pool.unsafe(sql, values),
    close: (options) => pool.close(options),
  }
  const runtime = createPostgresqlDatabaseRuntime({
    config: PostgresqlDatabaseConfigSchema.parse({
      provider: 'postgresql',
      urlEnv: 'LIVE_TARGET_URL',
    }),
    generationId: h.generationId,
    env: { LIVE_TARGET_URL: 'postgresql://localhost/recorded_target' },
    poolFactory: () => recordedPool,
  })
  const open = () =>
    openPostgresqlLogicalTarget({
      runtime,
      operationId: 'dbm_target_0001',
      sourceGenerationId: 'dbg_source_0001',
      headContract: logicalSchemaContract,
      contract: logicalSchemaContract,
      plan: LIVE_PLAN,
    })
  let first = await open()
  await first.prepare(1)
  await first.copyChunk(
    LIVE_TABLE,
    createLogicalTableChunk({
      operationId: 'dbm_target_0001',
      contract: logicalSchemaContract,
      table: LIVE_TABLE,
      chunkIndex: 0,
      rows: [1, 2].map((n) =>
        encodeLogicalRow(LIVE_TABLE, { key: `fixture-${n}`, value: 'retained', updated_at: 1 }),
      ),
    }),
    2,
  )
  if (input.rowCount === 0) await h.target.execute('DELETE FROM agent_workflow.maintenance_state')
  if (input.rowCount === 3)
    await h.target.execute(
      "INSERT INTO agent_workflow.maintenance_state VALUES ('extra','extra',1)",
    )
  if (input.receiptTable)
    await h.target.execute('UPDATE agent_workflow_meta.migration_units SET unit_json=$1', [
      JSON.stringify({ table: input.receiptTable, chunk: 0 }),
    ])
  if (input.extraTable)
    await h.target.execute('CREATE TABLE agent_workflow.legacy_omitted(id text)')
  if (input.stage === 'activated') {
    await first.finalizeSchema(3, LIVE_EXPECTED)
    await first.prepareGeneration({
      generationId: 'dbg_target_0001',
      sourceGenerationId: 'dbg_source_0001',
    })
    await first.activateGeneration('dbg_target_0001', 4)
    if (input.active === false)
      await h.target.execute(
        "UPDATE agent_workflow_meta.generations SET state='retired' WHERE generation_id='dbg_target_0001'",
      )
  }
  statements.length = 0
  return {
    statements,
    get releases() {
      return releases
    },
    get reservations() {
      return reservations
    },
    async open() {
      if (first) {
        const current = first
        first = undefined!
        return current
      }
      return open()
    },
  }
}

describeV3Providers('RFC-349 live epoch-2 PostgreSQL logical target finalization', (h) => {
  if (h.targetProvider !== 'postgresql') return
  // RFC-349: copied rows need planner statistics before serving traffic.
  test('analyzes every active target table once the schema is finalized', async () => {
    const fake = await liveFixture(h)
    const target = await fake.open()
    try {
      await target.finalizeSchema(10, LIVE_EXPECTED)
      const analyze = fake.statements.filter((sql) => sql.startsWith('ANALYZE '))
      expect(analyze).toEqual(
        logicalSchemaContract.tables.map(
          (table) => `ANALYZE "agent_workflow"."${table.providerTables.postgresql}"`,
        ),
      )
      for (const sql of analyze)
        expect(fake.statements.indexOf(sql)).toBeGreaterThan(fake.statements.lastIndexOf('COMMIT'))
    } finally {
      await target.close()
    }
  })

  test('re-analyzes on the resume path, where finalization already committed', async () => {
    const fake = await liveFixture(h)
    const target = await fake.open()
    try {
      await target.finalizeSchema(10, LIVE_EXPECTED)
      const first = fake.statements.length
      await target.finalizeSchema(11, LIVE_EXPECTED)
      expect(fake.statements.slice(first).filter((sql) => sql.startsWith('ANALYZE '))).toEqual(
        logicalSchemaContract.tables.map(
          (table) => `ANALYZE "agent_workflow"."${table.providerTables.postgresql}"`,
        ),
      )
    } finally {
      await target.close()
    }
  })

  test('projects every live provider-specific physical table mapping', () => {
    expect(LIVE_PLAN.schemaEpoch).toBe(2)
    expect(LIVE_PLAN.digest).toBe(persistenceHead().postgresql.digest)
    for (const table of logicalSchemaContract.tables)
      expect(
        LIVE_PLAN.statements.find(
          (statement) => statement.kind === 'table' && statement.logicalId === table.id,
        )?.sql,
      ).toContain(`"agent_workflow"."${table.providerTables.postgresql}"`)
  })

  test('blocks schema finalization when final target row coverage differs', async () => {
    const fake = await liveFixture(h, { rowCount: 3 })
    const target = await fake.open()
    try {
      await expect(target.finalizeSchema(10, LIVE_EXPECTED)).rejects.toMatchObject({
        code: 'postgresql-target-verification',
      })
      expect(fake.statements).toContain('ROLLBACK')
      expect(LIVE_FOREIGN_KEYS.length).toBeGreaterThan(0)
      for (const statement of LIVE_FOREIGN_KEYS)
        expect(fake.statements).not.toContain(statement.sql)
    } finally {
      await target.close()
    }
    expect(fake.releases).toBe(1)
  })

  test('blocks finalization when the application schema gains an extra table', async () => {
    const fake = await liveFixture(h, { extraTable: true })
    const target = await fake.open()
    try {
      await expect(target.finalizeSchema(10, LIVE_EXPECTED)).rejects.toMatchObject({
        code: 'postgresql-target-schema-finalize',
        cause: { code: 'physical-drift' },
      })
      expect(fake.statements).toContain('ROLLBACK')
      expect(fake.statements.some((sql) => sql.startsWith('ANALYZE '))).toBeFalse()
      expect(
        fake.statements.some((sql) => sql.startsWith('UPDATE "agent_workflow_meta"."generations"')),
      ).toBeFalse()
    } finally {
      await target.close()
    }
  })

  test('blocks finalization when copy receipts name a non-active table', async () => {
    // All active rows and receipts are empty and agree. Only the orphan receipt is invalid.
    const fake = await liveFixture(h, { rowCount: 0, receiptTable: 'legacy_omitted' })
    const target = await fake.open()
    try {
      await expect(
        target.finalizeSchema(
          10,
          LIVE_EXPECTED.map((table) => ({ ...table, rowCount: 0, chunkCount: 0 })),
        ),
      ).rejects.toBeInstanceOf(PostgresqlLogicalTargetError)
      expect(fake.statements).toContain('ROLLBACK')
      for (const statement of LIVE_FOREIGN_KEYS)
        expect(fake.statements).not.toContain(statement.sql)
    } finally {
      await target.close()
    }
  })

  test('observes a committed finalization idempotently without replaying DDL', async () => {
    const fake = await liveFixture(h)
    const first = await fake.open()
    try {
      await first.finalizeSchema(10, LIVE_EXPECTED)
    } finally {
      await first.close()
    }
    const resumed = await fake.open()
    try {
      await resumed.finalizeSchema(11, LIVE_EXPECTED)
      expect(LIVE_FOREIGN_KEYS.length).toBeGreaterThan(0)
      for (const statement of LIVE_FOREIGN_KEYS)
        expect(fake.statements.filter((sql) => sql === statement.sql)).toHaveLength(1)
      expect(
        fake.statements.filter((sql) =>
          sql.startsWith('INSERT INTO "agent_workflow_meta"."migration_records"'),
        ),
      ).toHaveLength(1)
    } finally {
      await resumed.close()
    }
    expect(fake.releases).toBe(2)
    expect(fake.reservations).toBe(2)
  })

  test('checks cutover readiness on the advisory-lock session', async () => {
    const fake = await liveFixture(h, { stage: 'activated' })
    const target = await fake.open()
    try {
      await target.assertReady('dbg_target_0001')
      expect(fake.statements).toContain(
        `SELECT generation_id FROM "agent_workflow_meta"."generations" WHERE generation_id=$1 AND state='active'`,
      )
      expect(fake.statements).toContain(
        `SELECT record_json, record_digest FROM "agent_workflow_meta"."migration_records" WHERE run_id=$1 AND unit_id='epoch2-copy' AND ordinal=0`,
      )
      expect(fake.reservations).toBe(1)
    } finally {
      await target.close()
    }
    expect(fake.releases).toBe(1)
    for (const input of [
      { active: false, stage: 'activated' as const },
      { stage: 'prepared' as const },
    ]) {
      const blocked = await liveFixture(h, input)
      const target = await blocked.open()
      try {
        await expect(target.assertReady('dbg_target_0001')).rejects.toMatchObject({
          code: 'postgresql-target-generation-fence',
        })
      } finally {
        await target.close()
      }
    }
  })
})
