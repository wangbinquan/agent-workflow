// RFC-349 AC-8 / D11 — the PostgreSQL migration target must reject torn
// cross-table state and identity sequences whose next value can collide. These
// oracles run through the already-reserved migration connection; there is no
// second connection or nested transaction hidden in the verifier.

import { describe, expect, test } from 'bun:test'
import {
  POSTGRESQL_LOGICAL_TARGET_INVARIANT_IDS,
  PostgresqlLogicalTargetInvariantError,
  verifyPostgresqlLogicalTargetBusinessInvariants,
  verifyPostgresqlLogicalTargetIdentitySequences,
} from '@/platform/persistence/postgresqlLogicalTargetInvariants'
import type {
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import {
  buildLogicalSchemaContract,
  type LogicalColumnContract,
  type LogicalSchemaContract,
  type LogicalTableContract,
} from '@/platform/persistence/schemaContract'

function rows(values: readonly Record<string, unknown>[]): SqlRows {
  return Object.assign(Promise.resolve(values), {
    async values() {
      return values.map((value) => Object.values(value))
    },
  })
}

const ID_COLUMN: LogicalColumnContract = {
  name: 'id',
  logicalCodec: 'integer',
  nullable: false,
  primary: true,
  hasDefault: true,
  defaultKind: 'identity',
  defaultValue: null,
  providerDefault: { sqlite: null, postgresql: null },
  identity: true,
  uniqueName: null,
  enumValues: [],
  providerType: { sqlite: 'integer', postgresql: 'bigint' },
}

function table(
  id: string,
  columns: readonly LogicalColumnContract[] = [ID_COLUMN],
): LogicalTableContract {
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
      rule: 'rfc349 invariant fixture',
    },
    consumers: {
      productionReader: 'owner-required',
      productionWriter: 'owner-required-or-immutable',
      backgroundRecoveryDiagnostic: 'owner-reviewed',
      evidence: 'rfc349 invariant fixture',
    },
    rationale: 'rfc349 invariant fixture',
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
    digest: `sha256:${'a'.repeat(64)}`,
  }
}

describe('RFC-349 PostgreSQL logical-target business invariants', () => {
  test('the canonical 178-table contract binds every closed D11 invariant', async () => {
    const statements: string[] = []
    const connection: PostgresqlReservedConnection = {
      unsafe(sql) {
        statements.push(sql)
        return rows([])
      },
      release() {},
    }

    await verifyPostgresqlLogicalTargetBusinessInvariants({
      connection,
      contract: buildLogicalSchemaContract(),
    })

    expect(statements).toHaveLength(POSTGRESQL_LOGICAL_TARGET_INVARIANT_IDS.length)
    expect(POSTGRESQL_LOGICAL_TARGET_INVARIANT_IDS).toEqual([
      'task-ownership-epoch',
      'task-effect-attempt-chain',
      'task-effect-fence-epoch',
      'task-maintenance-completion',
      'committed-event-head',
      'committed-event-delivery',
      'intent-apply-convergence',
      'resource-package-apply-convergence',
      'canonical-intent-provenance',
      'digital-employee-outbox-lease',
      'digital-employee-context-revision',
      'resource-current-revision-pointers',
      'digital-development-saga-attempt-effect',
      'auth-resource-grant-reference',
      'intent-session-reference',
    ])
    const resourceGrantInvariant = statements.find((statement) =>
      statement.includes('rfc349-invariant:auth-resource-grant-reference'),
    )
    expect(resourceGrantInvariant).toContain('AS resource_grant')
    expect(resourceGrantInvariant).not.toMatch(/\bAS grant\b/)
  })

  test('a partially present invariant family fails closed before SQL runs', async () => {
    let queryCount = 0
    const connection: PostgresqlReservedConnection = {
      unsafe() {
        queryCount += 1
        return rows([])
      },
      release() {},
    }

    let failure: unknown
    try {
      await verifyPostgresqlLogicalTargetBusinessInvariants({
        connection,
        contract: contract([table('task_execution_effects')]),
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(PostgresqlLogicalTargetInvariantError)
    expect(failure).toMatchObject({
      invariant: 'task-ownership-epoch',
      table: 'task_execution_owners',
      key: 'contract-missing',
    })
    expect(queryCount).toBe(0)
  })

  test('reports the exact invariant, table and business key', async () => {
    const connection: PostgresqlReservedConnection = {
      unsafe(sql) {
        expect(sql).toContain('rfc349-invariant:intent-apply-convergence')
        return rows([{ invariant_table: 'intent_apply_journal', invariant_key: 'apply-7' }])
      },
      release() {},
    }

    let failure: unknown
    try {
      await verifyPostgresqlLogicalTargetBusinessInvariants({
        connection,
        contract: contract([table('intent_apply_journal')]),
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(PostgresqlLogicalTargetInvariantError)
    expect(failure).toMatchObject({
      invariant: 'intent-apply-convergence',
      table: 'intent_apply_journal',
      key: 'apply-7',
    })
    expect(String(failure)).toContain('intent_apply_journal:apply-7')
  })
})

describe('RFC-349 PostgreSQL identity next-value collision oracle', () => {
  test('restores sequence state and rejects a colliding next value', async () => {
    const calls: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
    const connection: PostgresqlReservedConnection = {
      unsafe(sql, parameters) {
        calls.push({ sql, parameters })
        if (sql.includes('pg_get_serial_sequence')) {
          return rows([{ sequence_name: 'agent_workflow.fixture_rows_pg_id_seq' }])
        }
        if (sql.startsWith('SELECT last_value')) {
          return rows([{ last_value: '41', is_called: true }])
        }
        if (sql.startsWith('SELECT MAX')) return rows([{ max_value: '42' }])
        if (sql.includes('nextval')) return rows([{ next_value: '42' }])
        return rows([])
      },
      release() {},
    }

    let failure: unknown
    try {
      await verifyPostgresqlLogicalTargetIdentitySequences({
        connection,
        contract: contract([table('fixture_rows')]),
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      invariant: 'identity-sequence-next-value',
      table: 'fixture_rows',
      key: 'id:42',
    })
    const restore = calls.find((call) => call.sql.startsWith('SELECT setval($1::regclass'))
    expect(restore?.parameters).toEqual(['agent_workflow.fixture_rows_pg_id_seq', 41n, true])
  })

  test('accepts a strictly greater next value without committing a probe row', async () => {
    const statements: string[] = []
    const connection: PostgresqlReservedConnection = {
      unsafe(sql) {
        statements.push(sql)
        if (sql.includes('pg_get_serial_sequence')) {
          return rows([{ sequence_name: 'agent_workflow.fixture_rows_pg_id_seq' }])
        }
        if (sql.startsWith('SELECT last_value')) {
          return rows([{ last_value: '42', is_called: true }])
        }
        if (sql.startsWith('SELECT MAX')) return rows([{ max_value: '42' }])
        if (sql.includes('nextval')) return rows([{ next_value: '43' }])
        return rows([])
      },
      release() {},
    }

    await verifyPostgresqlLogicalTargetIdentitySequences({
      connection,
      contract: contract([table('fixture_rows')]),
    })

    expect(statements.some((sql) => /^INSERT\b/.test(sql))).toBeFalse()
    expect(statements.some((sql) => /^BEGIN\b/.test(sql))).toBeFalse()
  })
})
