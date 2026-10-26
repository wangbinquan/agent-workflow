// AF-D21: exercise the live epoch-2 provider-move protocol.
// 2026-09-04 单笔修复（非 RFC）—— SQLite → PostgreSQL 迁移在 `verifying` 阶段
// 必败的一条链，三堵墙一次钉住：
//
//  1. 迁移那条 reserved session 继承了守在线请求的服务端超时。`idleTimeoutMs`
//     （默认 30s）被当成 `idle_in_transaction_session_timeout`、`statementTimeoutMs`
//     （默认 60s）被当成 `statement_timeout`，而 `finalizeSchema` 把「覆盖度普查 +
//     15 条跨表不变量 + 524 条索引/约束 DDL」放在同一个事务里，跑在一个还没有任何
//     索引的多 GB 目标库上。30s 的客户端空隙 → 服务端掐掉会话（25P03）；单条
//     `CREATE INDEX` 超 60s → 取消（57014）。两堵墙在生产上都是常态。
//  2. 两个校验器把**任何**查询失败压成
//     `PostgresqlLogicalTargetInvariantError(..., 'query-error')`——基础设施故障
//     被登记成数据完整性违规，原始 error 连 `cause` 都不留。
//  3. 于是分类命中 `verification-mismatch` / `retryable: false`，
//     `resumeDatabaseMigration` 直接拒绝续跑；而失败记录只有 `category` +
//     `detailCode`，运维连是哪条不变量都看不到。
//
// 这些用例一旦转红，就是上面某一堵墙被重新砌了回去。

import { withNativeTransactions } from './helpers/nativeTransactions'
import { describe, expect, test } from 'bun:test'
import {
  openPostgresqlLogicalTarget,
  PostgresqlLogicalTargetError,
} from '@/platform/persistence/postgresqlLogicalTarget'
import {
  PostgresqlLogicalTargetInvariantError,
  verifyPostgresqlLogicalTargetBusinessInvariants,
  verifyPostgresqlLogicalTargetIdentitySequences,
} from '@/platform/persistence/postgresqlLogicalTargetInvariants'
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
import { persistenceHead, persistencePostgresqlCatalogs } from '@/bootstrap/persistenceHead'
import { digestSchemaContract } from '@/platform/persistence/schemaContract'
import { classifyDatabaseMigrationFailure } from '@/modules/system-operations/application/databaseMigrationRunner'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'

const CONTRACT_DIGEST = `sha256:${'c'.repeat(64)}`

function rows(values: readonly Record<string, unknown>[]): SqlRows {
  return Object.assign(Promise.resolve(values), {
    async values() {
      return values.map((value) => Object.values(value))
    },
  })
}

function column(input: { readonly identity: boolean }): LogicalColumnContract {
  return {
    name: 'id',
    logicalCodec: input.identity ? 'integer' : 'text-identity',
    nullable: false,
    primary: true,
    hasDefault: input.identity,
    defaultKind: input.identity ? 'identity' : 'none',
    defaultValue: null,
    providerDefault: { sqlite: null, postgresql: null },
    identity: input.identity,
    uniqueName: null,
    enumValues: [],
    providerType: { sqlite: input.identity ? 'integer' : 'text', postgresql: 'text' },
  }
}

function table(id: string, columns: readonly LogicalColumnContract[]): LogicalTableContract {
  return {
    id,
    schemaSymbol: id,
    ownerContext: 'system-operations',
    disposition: 'KEEP',
    sourceTable: id,
    providerTables: { sqlite: id, postgresql: `${id}_pg` },
    migrationKey: ['id'],
    columns,
    primaryKey: ['id'],
    unique: [],
    foreignKeys: [],
    checks: [],
    indexes: [],
    retention: {
      class: 'owner-managed-business',
      owner: 'system-operations',
      rule: 'rfc349 long-transaction fixture',
    },
    consumers: {
      productionReader: 'owner-required',
      productionWriter: 'owner-required-or-immutable',
      backgroundRecoveryDiagnostic: 'owner-reviewed',
      evidence: 'rfc349 long-transaction fixture',
    },
    rationale: 'rfc349 long-transaction fixture',
  }
}

function contract(tables: readonly LogicalTableContract[]): LogicalSchemaContract {
  return {
    contractVersion: 2,
    sourceProjection: 'sqlite',
    sourceTableCount: tables.length,
    activeTableCount: tables.length,
    archiveOnlyTableCount: 0,
    tables,
    digest: CONTRACT_DIGEST,
  }
}

// The two tables that close the `intent-apply-convergence` and
// `canonical-intent-provenance` families; every other family stays unbound, so
// this contract runs exactly two oracles and nothing fails closed on absence.
const CONTRACT = contract([
  table('intent_apply_journal', [column({ identity: false })]),
  table('intent_provenance', [column({ identity: false })]),
])

const PLAN = buildPostgresqlSchemaPlan(logicalSchemaContract)
const EXPECTED = logicalSchemaContract.tables.map((table) => ({
  table: table.id,
  disposition: table.disposition,
  rowCount: 0,
  chunkCount: 0,
}))

function fixture(
  input: {
    readonly onInvariantQuery?: () => SqlRows
    readonly onCountQuery?: () => SqlRows
    readonly identityNext?: number
  } = {},
) {
  const statements: string[] = []
  const head = persistenceHead()
  const artifact = persistencePostgresqlCatalogs()[0]!
  let state = {
    sourceGenerationId: 'dbg_source_0001',
    contractDigest: logicalSchemaContract.digest,
    planDigest: PLAN.digest,
    stage: 'prepared',
  }
  const connection: PostgresqlReservedConnection = withNativeTransactions({
    unsafe(sql, values = []) {
      statements.push(sql)
      if (sql.includes('pg_try_advisory_lock')) return rows([{ acquired: true }])
      if (sql.includes('pg_advisory_unlock')) return rows([{ released: true }])
      if (sql.includes('SELECT COUNT(*)')) return input.onCountQuery?.() ?? rows([{ count: 0 }])
      if (sql.includes('rfc349-invariant:')) return input.onInvariantQuery?.() ?? rows([])
      if (sql.includes('pg_get_serial_sequence') && !sql.includes('setval'))
        return rows([{ sequence_name: 'agent_workflow.fixture_identity_seq' }])
      if (sql.includes('SELECT last_value')) return rows([{ last_value: 1, is_called: false }])
      if (sql.includes('AS max_value')) return rows([{ max_value: null }])
      if (sql.includes('SELECT nextval')) return rows([{ next_value: input.identityNext ?? 1 }])
      if (sql.includes('FROM "agent_workflow_meta"."migration_records"'))
        return rows([
          { record_json: JSON.stringify(state), record_digest: digestSchemaContract(state) },
        ])
      if (sql.startsWith('INSERT INTO "agent_workflow_meta"."migration_records"')) {
        state = JSON.parse(String(values[1]))
        return rows([])
      }
      if (sql.includes('SELECT 1 FROM information_schema.tables')) return rows([{ present: 1 }])
      if (sql.includes('FROM "agent_workflow_meta"."schema_history"'))
        return rows([
          {
            version: head.contract.version,
            contract_digest: head.contract.contract.digest,
            sqlite_plan_digest: head.sqlite.digest,
            postgresql_plan_digest: head.postgresql.digest,
            applied_at: 1,
            artifact_json: JSON.stringify(head),
          },
        ])
      if (sql.includes("current_setting('server_version_num')"))
        return rows([{ version: artifact.postgresqlMajor * 10000 }])
      if (sql.includes("SELECT 'relation' AS kind"))
        return rows(artifact.catalog.map((entry) => ({ ...entry })))
      return rows([])
    },
    release() {},
  })
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
  return { runtime, statements }
}

async function openTarget(fake: ReturnType<typeof fixture>) {
  return openPostgresqlLogicalTarget({
    headContract: logicalSchemaContract,
    runtime: fake.runtime,
    operationId: 'dbm_target_0001',
    sourceGenerationId: 'dbg_source_0001',
    contract: logicalSchemaContract,
    plan: PLAN,
    verifyMigrationHistory: async () => undefined,
  })
}

describe('RFC-349 migration session outlives the daemon online timeouts', () => {
  test('the reserved migration session drops statement/idle guards before it does anything else', async () => {
    const fake = fixture()
    const target = await openTarget(fake)
    await target.close()

    const configure = fake.statements[0] ?? ''
    expect(configure).toContain("set_config('statement_timeout', '0', false)")
    expect(configure).toContain("set_config('idle_in_transaction_session_timeout', '0', false)")
    // Before the advisory lock, so no statement on this session ever runs under
    // the online budget.
    expect(fake.statements.findIndex((sql) => sql.includes('pg_try_advisory_lock'))).toBe(1)
  })

  test('a clean finalize still commits, and never touches lock_timeout', async () => {
    const fake = fixture()
    const target = await openTarget(fake)
    await target.finalizeSchema(10, EXPECTED)
    await target.close()

    expect(fake.statements.filter((sql) => sql.includes('SELECT COUNT(*)'))).toHaveLength(
      logicalSchemaContract.tables.length,
    )
    expect(fake.statements.some((sql) => sql.includes('FOREIGN KEY'))).toBeTrue()
    expect(fake.statements).toContain('COMMIT')
    // `lock_timeout` measures someone ELSE blocking us, so it stays at the
    // configured budget rather than being disabled with the other two.
    expect(fake.statements.some((sql) => sql.includes('lock_timeout'))).toBeFalse()
  })
})

describe('RFC-349 a failed verification query is not a verification verdict', () => {
  test('the business-invariant oracle lets the driver failure through untouched', async () => {
    const driverFailure = new Error('connection must be a PostgresSQLConnection')
    const connection: PostgresqlReservedConnection = withNativeTransactions({
      unsafe() {
        throw driverFailure
      },
      release() {},
    })

    let failure: unknown
    try {
      await verifyPostgresqlLogicalTargetBusinessInvariants({ connection, contract: CONTRACT })
    } catch (error) {
      failure = error
    }

    // The driver error arrives intact: not relabelled as a verdict, not reduced
    // to a `query-error` key with the provider's own code thrown away.
    expect(failure).toBe(driverFailure)
    expect(failure).not.toBeInstanceOf(PostgresqlLogicalTargetInvariantError)
  })

  test('the identity-sequence oracle lets the driver failure through untouched', async () => {
    const driverFailure = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    })
    const connection: PostgresqlReservedConnection = withNativeTransactions({
      unsafe() {
        throw driverFailure
      },
      release() {},
    })

    let failure: unknown
    try {
      await verifyPostgresqlLogicalTargetIdentitySequences({
        connection,
        contract: contract([table('intent_apply_journal', [column({ identity: true })])]),
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBe(driverFailure)
    expect(failure).not.toBeInstanceOf(PostgresqlLogicalTargetInvariantError)
  })

  test('finalizeSchema reports a torn-down session as a finalize fault carrying the driver error', async () => {
    const driverFailure = new Error('connection must be a PostgresSQLConnection')
    const fake = fixture({
      onInvariantQuery: () => {
        throw driverFailure
      },
    })
    const target = await openTarget(fake)

    let failure: unknown
    try {
      await target.finalizeSchema(10, EXPECTED)
    } catch (error) {
      failure = error
    } finally {
      await target.close()
    }

    expect(failure).toBeInstanceOf(PostgresqlLogicalTargetError)
    // Not `postgresql-target-verification`: nothing was verified and found wrong.
    expect((failure as PostgresqlLogicalTargetError).code).toBe('postgresql-target-schema-finalize')
    expect((failure as Error).cause).toBe(driverFailure)
    expect(fake.statements).toContain('ROLLBACK')
  })

  test('BF-D8 a real D11 violation fails closed through the live target and names its invariant', async () => {
    const fake = fixture({
      onInvariantQuery: () =>
        rows([
          { invariant_table: 'task_execution_intents', invariant_key: 'intent-without-owner' },
        ]),
    })
    const target = await openTarget(fake)
    try {
      await expect(target.finalizeSchema(10, EXPECTED)).rejects.toMatchObject({
        code: 'postgresql-target-verification.task-ownership-epoch',
        message: expect.stringContaining('intent-without-owner'),
      })
      expect(fake.statements).toContain('ROLLBACK')
      expect(fake.statements.some((sql) => sql.includes('FOREIGN KEY'))).toBeFalse()
    } finally {
      await target.close()
    }
  })

  test('BF-D8 the live target also refuses an invalid identity sequence', async () => {
    const fake = fixture({ identityNext: 0 })
    const target = await openTarget(fake)
    try {
      await expect(target.finalizeSchema(10, EXPECTED)).rejects.toMatchObject({
        code: 'postgresql-target-verification.identity-sequence-next-value',
      })
      expect(fake.statements).toContain('ROLLBACK')
    } finally {
      await target.close()
    }
  })

  test('a native row-count mismatch fails before foreign-key finalization', async () => {
    const fake = fixture({
      onCountQuery: () => rows([{ count: 1 }]),
    })
    const target = await openTarget(fake)

    let failure: unknown
    try {
      await target.finalizeSchema(10, EXPECTED)
    } catch (error) {
      failure = error
    } finally {
      await target.close()
    }

    expect(failure).toBeInstanceOf(PostgresqlLogicalTargetError)
    expect((failure as PostgresqlLogicalTargetError).code).toBe('postgresql-target-verification')
    expect(String(failure)).toContain(logicalSchemaContract.tables[0]!.id)
    // No DDL is attempted once the closed oracle has spoken.
    expect(fake.statements.some((sql) => sql.includes('FOREIGN KEY'))).toBeFalse()
  })
})

describe('RFC-349 verifying-phase failure classification', () => {
  // The exact production shape: Bun.SQL surfaces a server-terminated session as a
  // bare Error with no `code`/`sqlState`, wrapped by the finalize catch.
  test('a torn-down session during verifying is a retryable target outage', () => {
    const failure = new PostgresqlLogicalTargetError(
      'postgresql-target-schema-finalize',
      'PostgreSQL target constraints, indexes or identities failed final verification',
      { cause: new Error('connection must be a PostgresSQLConnection') },
    )

    expect(classifyDatabaseMigrationFailure(failure, 'verifying')).toMatchObject({
      category: 'target-unreachable',
      retryable: true,
    })
  })

  test('a statement timeout during verifying is a retryable target outage', () => {
    const failure = new PostgresqlLogicalTargetError(
      'postgresql-target-schema-finalize',
      'PostgreSQL target constraints, indexes or identities failed final verification',
      {
        cause: Object.assign(new Error('canceling statement due to statement timeout'), {
          code: '57014',
        }),
      },
    )

    expect(classifyDatabaseMigrationFailure(failure, 'verifying')).toMatchObject({
      category: 'target-unreachable',
      retryable: true,
    })
  })

  test('an idle-in-transaction termination is a retryable target outage', () => {
    const failure = Object.assign(
      new Error('terminating connection due to idle-in-transaction timeout'),
      { code: 'ERR_POSTGRES_SERVER_ERROR' },
    )

    expect(classifyDatabaseMigrationFailure(failure, 'verifying')).toMatchObject({
      category: 'target-unreachable',
      retryable: true,
    })
  })

  test('a real invariant violation stays a permanent verification mismatch', () => {
    const failure = new PostgresqlLogicalTargetError(
      'postgresql-target-verification.intent-apply-convergence',
      'PostgreSQL target invariant intent-apply-convergence failed at intent_apply_journal:apply-7',
    )

    expect(classifyDatabaseMigrationFailure(failure, 'verifying')).toEqual({
      category: 'verification-mismatch',
      detailCode: 'postgresql-target-verification.intent-apply-convergence',
      retryable: false,
    })
  })
})
