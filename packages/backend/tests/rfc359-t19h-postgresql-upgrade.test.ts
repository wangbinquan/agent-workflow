// RFC-359 T19h: exercise the reserved-connection protocol around a published
// baseline. Real PostgreSQL DDL and nonempty-row preservation have a separate
// hosted suite; these controlled faults pin rollback and pointer repair order.
import { beforeAll, describe, expect, test } from 'bun:test'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import type { PostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationSequence'
import { migratePostgresqlSchema } from '@/platform/persistence/postgresqlMigrator'
import {
  POSTGRESQL_BASELINE_ID,
  type PostgresqlSchemaStatement,
} from '@/platform/persistence/postgresqlSchema'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

let history: PostgresqlMigrationHistory
beforeAll(async () => {
  history = await loadPostgresqlMigrationHistory()
})

const generation = {
  generationId: 'dbg_rfc359_upgrade',
  operationId: 'dbm_rfc359_original_copy',
}

function rows(values: readonly Record<string, unknown>[]): SqlRows {
  return Object.assign(Promise.resolve(values), {
    async values() {
      return values.map((row) => Object.values(row))
    },
  })
}

function fixture(
  input: {
    failSql?: string
    missContractUpdate?: boolean
    heldKey?: string
    missingBaseline?: boolean
  } = {},
) {
  const calls: { sql: string; parameters: readonly unknown[] }[] = []
  const initial = {
    contractDigest: history.root.contract.digest,
    migrations: [
      {
        baseline_id: POSTGRESQL_BASELINE_ID,
        contract_digest: history.root.contract.digest,
        plan_digest: history.root.plan.digest,
      },
    ],
    generations: [
      {
        generation_id: generation.generationId,
        operation_id: generation.operationId,
        contract_digest: history.root.contract.digest,
        state: 'active',
        first_live_write_at: 123,
      },
      {
        generation_id: 'dbg_rfc359_retired',
        operation_id: 'dbm_rfc359_older_copy',
        contract_digest: history.root.contract.digest,
        state: 'retired',
        first_live_write_at: 100,
      },
    ],
    installed: [] as string[],
  }
  if (input.missingBaseline) initial.migrations = []
  let committed = structuredClone(initial)
  let pending: typeof committed | undefined
  let releases = 0
  const state = () => pending ?? committed
  const upgrades = history.steps.flatMap((step) =>
    step.executableStatements.map((statement) => ({ statement, step })),
  )
  const connection: PostgresqlReservedConnection = {
    unsafe(sql, parameters = []) {
      calls.push({ sql, parameters })
      if (sql === input.failSql) throw new Error('injected index build interruption')
      if (sql.includes('pg_try_advisory_lock')) {
        return rows([{ acquired: parameters[0] !== input.heldKey }])
      }
      if (sql.includes('pg_advisory_unlock') || sql.includes("set_config('statement_timeout'")) {
        return rows([])
      }
      if (sql.includes('information_schema.tables')) {
        return rows([
          ...history.root.plan.statements
            .filter((statement) => statement.kind === 'table')
            .map((statement) => ({
              table_schema: 'agent_workflow',
              table_name: statement.logicalId,
            })),
          ...['schema_migrations', 'schema_contract', 'database_generations'].map((table_name) => ({
            table_schema: 'agent_workflow_meta',
            table_name,
          })),
        ])
      }
      if (sql.startsWith('SELECT contract_digest, plan_digest')) {
        return rows(state().migrations.filter((row) => row.baseline_id === parameters[0]))
      }
      if (sql.startsWith('SELECT baseline_id, contract_digest, plan_digest')) {
        // The read intentionally supplies no timestamp ordering.
        return rows([...state().migrations].reverse())
      }
      if (sql.startsWith('SELECT contract_digest, active_table_count')) {
        return rows([
          {
            contract_digest: state().contractDigest,
            active_table_count: history.root.plan.activeTableCount,
            archive_only_table_count: history.root.plan.archiveOnlyTableCount,
          },
        ])
      }
      if (sql.startsWith('SELECT generation_id, operation_id, contract_digest')) {
        return rows(state().generations.filter((row) => row.state === 'active'))
      }
      if (sql === 'BEGIN') {
        if (pending !== undefined) throw new Error('unexpected nested migration transaction')
        pending = structuredClone(committed)
        return rows([])
      }
      if (sql === 'COMMIT') {
        if (pending === undefined) throw new Error('no migration transaction to commit')
        committed = pending
        pending = undefined
        return rows([])
      }
      if (sql === 'ROLLBACK') {
        pending = undefined
        return rows([])
      }
      if (pending === undefined) throw new Error('schema mutation outside the reserved transaction')
      if (sql.startsWith('INSERT INTO "agent_workflow_meta"."schema_migrations"')) {
        pending.migrations.push({
          baseline_id: String(parameters[0]),
          contract_digest: String(parameters[1]),
          plan_digest: String(parameters[2]),
        })
        return rows([])
      }
      if (sql.startsWith('UPDATE "agent_workflow_meta"."database_generations"')) {
        const matched = pending.generations.filter(
          (row) => row.state === 'active' && row.contract_digest === parameters[1],
        )
        for (const row of matched) row.contract_digest = String(parameters[0])
        return rows(matched)
      }
      const matched = upgrades.find(({ statement }) => statement.sql === sql)
      if (matched?.statement.kind === 'index') {
        pending.installed.push(sql)
        return rows([])
      }
      if (matched?.statement.logicalId === 'advance-contract-row') {
        if (
          input.missContractUpdate ||
          pending.contractDigest !== matched.step.from.contractDigest
        ) {
          return rows([])
        }
        pending.contractDigest = matched.step.to.contractDigest
        return rows([{ contract_digest: pending.contractDigest }])
      }
      throw new Error('unexpected schema statement in controlled fixture')
    },
    release() {
      releases += 1
    },
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: generation.generationId,
    async health() {
      throw new Error('unused health probe')
    },
    async readiness() {
      throw new Error('unused readiness probe')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('unused copy lock')
    },
    providerPool: () => ({
      reserve: async () => connection,
      unsafe: connection.unsafe,
      close: async () => undefined,
    }),
    close: async () => undefined,
  }
  return {
    runtime,
    calls,
    initial,
    committed: () => structuredClone(committed),
    releases: () => releases,
    selected: { ...generation, expectedContractDigest: history.root.contract.digest },
  }
}

function indexStatements(): readonly PostgresqlSchemaStatement[] {
  return history.steps.flatMap((step) =>
    step.executableStatements.filter((statement) => statement.kind === 'index'),
  )
}

describe('RFC-359 T19h schema transaction and pointer continuation', () => {
  test('advances the schema and active generation together while preserving the original receipt', async () => {
    const db = fixture()
    const original = db.committed()
    let callbacks = 0
    const result = await migratePostgresqlSchema({
      runtime: db.runtime,
      history,
      activeGeneration: db.selected,
      now: () => 123,
      afterCommitted(receipt) {
        callbacks += 1
        expect(receipt.applied).toBe(true)
        expect(db.calls.some((call) => call.sql === 'COMMIT')).toBe(true)
        expect(db.calls.some((call) => call.sql.includes('pg_advisory_unlock'))).toBe(false)
        expect(db.committed().contractDigest).toBe(history.head.contract.digest)
      },
    })
    expect(result).toMatchObject({ applied: true, planDigest: history.head.plan.digest })
    expect(db.committed().migrations[0]).toEqual(original.migrations[0])
    expect(db.committed().migrations).toHaveLength(1 + history.steps.length)
    expect(db.committed().installed).toEqual(indexStatements().map((statement) => statement.sql))
    expect(db.committed().generations[0]).toEqual({
      ...original.generations[0]!,
      contract_digest: history.head.contract.digest,
    })
    expect(db.committed().generations[1]).toEqual(original.generations[1])
    expect(callbacks).toBe(1)
    expect(db.releases()).toBe(1)
  })

  test('a second index failure rolls back the first index and every metadata change', async () => {
    expect(indexStatements().length).toBeGreaterThanOrEqual(2)
    const db = fixture({ failSql: indexStatements()[1]!.sql })
    let callbacks = 0
    await expect(
      migratePostgresqlSchema({
        runtime: db.runtime,
        history,
        afterCommitted: () => {
          callbacks += 1
        },
      }),
    ).rejects.toMatchObject({ code: 'postgresql-schema-prepare-failed' })
    expect(db.calls.some((call) => call.sql === indexStatements()[0]!.sql)).toBe(true)
    expect(db.calls.some((call) => call.sql === 'ROLLBACK')).toBe(true)
    expect(db.committed()).toEqual(db.initial)
    expect(callbacks).toBe(0)
    expect(db.releases()).toBe(1)
  })

  test('a missed current-contract row also rolls back the completed index statements', async () => {
    const db = fixture({ missContractUpdate: true })
    await expect(migratePostgresqlSchema({ runtime: db.runtime, history })).rejects.toMatchObject({
      code: 'postgresql-schema-drift',
    })
    expect(db.calls.some((call) => call.sql === 'ROLLBACK')).toBe(true)
    expect(db.committed()).toEqual(db.initial)
  })

  test('a failed pointer callback is retried after verification without repeating committed DDL', async () => {
    const db = fixture()
    const failure = new Error('injected atomic pointer write interruption')
    await expect(
      migratePostgresqlSchema({
        runtime: db.runtime,
        history,
        activeGeneration: db.selected,
        afterCommitted: () => {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
    const first = db.committed()
    expect(first.contractDigest).toBe(history.head.contract.digest)
    expect(db.calls.some((call) => call.sql === 'ROLLBACK')).toBe(false)
    let repairedDigest: string | undefined
    const result = await migratePostgresqlSchema({
      runtime: db.runtime,
      history,
      activeGeneration: db.selected,
      afterCommitted: (receipt) => {
        repairedDigest = receipt.contractDigest
      },
    })
    expect(result.applied).toBe(false)
    expect(repairedDigest).toBe(history.head.contract.digest)
    expect(db.committed()).toEqual(first)
    expect(db.calls.filter((call) => call.sql === 'BEGIN')).toHaveLength(1)
    expect(db.releases()).toBe(2)
  })

  test('an absent original baseline receipt does not start a transaction', async () => {
    const db = fixture({ missingBaseline: true })
    await expect(migratePostgresqlSchema({ runtime: db.runtime, history })).rejects.toMatchObject({
      code: 'postgresql-schema-partial',
    })
    expect(db.calls.some((call) => call.sql === 'BEGIN')).toBe(false)
    expect(db.committed()).toEqual(db.initial)
  })

  test('a held published-version lock releases the stable lock before returning', async () => {
    const stable = 'rfc359-schema-upgrade'
    const db = fixture({ heldKey: `rfc349-schema:${history.root.contract.digest}` })
    await expect(migratePostgresqlSchema({ runtime: db.runtime, history })).rejects.toMatchObject({
      code: 'postgresql-schema-lock-held',
    })
    expect(
      db.calls
        .filter((call) => call.sql.includes('pg_advisory_unlock'))
        .map((call) => call.parameters),
    ).toEqual([[stable]])
    expect(db.calls.some((call) => call.sql === 'BEGIN')).toBe(false)
    expect(db.releases()).toBe(1)
  })
})
