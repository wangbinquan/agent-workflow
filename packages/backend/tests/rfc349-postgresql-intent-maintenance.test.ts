import { afterEach, describe, expect, test } from 'bun:test'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import {
  createPostgresqlIntentApplyJournalConvergence,
  decodePostgresqlIntentApplyRecoveryArtifacts,
} from '@/modules/intent/infrastructure/postgresqlIntentApplyArtifactLifecycle'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

function rows(
  input: {
    readonly objects?: readonly Record<string, unknown>[]
    readonly values?: readonly (readonly unknown[])[]
    readonly count?: number
  } = {},
): SqlRows {
  const objects = [...(input.objects ?? [])] as Array<Record<string, unknown>> & {
    count?: number
  }
  objects.count = input.count ?? objects.length
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return input.values ?? []
    },
  })
}

function fixture(updatedAt: number) {
  const statements: string[] = []
  const execute = (sql: string): SqlRows => {
    statements.push(sql)
    const normalized = sql.trim().toLowerCase()
    if (/^(begin|commit|rollback)$/.test(normalized)) return rows()
    if (sql.includes('database_generations')) {
      return rows({
        objects: [{ generation_id: 'dbg_intent_maintenance_pg' }],
        values: [['dbg_intent_maintenance_pg']],
        count: 1,
      })
    }
    if (normalized.startsWith('select') && normalized.includes('intent_apply_journal')) {
      return rows({
        values: [
          [
            'journal-1',
            'session-1',
            'mutation-1',
            'draft-1',
            'hash-1',
            'prepared',
            '[]',
            null,
            null,
            100,
            updatedAt,
          ],
        ],
      })
    }
    if (normalized.startsWith('update') && normalized.includes('intent_apply_journal')) {
      return rows({ values: [['journal-1']], count: 1 })
    }
    throw new Error(`unexpected PostgreSQL intent maintenance query: ${sql}`)
  }
  const connection: PostgresqlReservedConnection = { unsafe: execute, release() {} }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: execute,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_intent_maintenance_pg',
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
  return { db: createPostgresqlDatabaseClient(runtime), statements }
}

const log = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} }) as never

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL Intent apply maintenance', () => {
  test('recovery decoder accepts native PostgreSQL and versioned migrated artifacts', () => {
    expect(
      decodePostgresqlIntentApplyRecoveryArtifacts(
        JSON.stringify([
          {
            kind: 'skill-version-stage',
            skillId: 'skill-1',
            operationId: 'operation-1',
            version: 2,
            stagingDirectory: '/app/skills/skill-1/files.op-operation-1.staged',
            versionDirectory: '/app/skills/skill-1/versions/2',
          },
        ]),
      ),
    ).toEqual([
      {
        kind: 'skill-version-stage',
        skillId: 'skill-1',
        operationId: 'operation-1',
        version: 2,
        stagingDirectory: '/app/skills/skill-1/files.op-operation-1.staged',
        versionDirectory: '/app/skills/skill-1/versions/2',
      },
    ])
    expect(
      decodePostgresqlIntentApplyRecoveryArtifacts(JSON.stringify({ version: 1, artifacts: [] })),
    ).toEqual([])
  })

  test('stale prepared journals compensate and settle through PostgreSQL CAS', async () => {
    const fake = fixture(100)
    let compensations = 0
    const convergence = createPostgresqlIntentApplyJournalConvergence({
      db: fake.db,
      artifacts: {
        async compensate() {
          compensations += 1
        },
        async rollForward() {
          throw new Error('prepared journal must not roll forward')
        },
      },
      now: () => 1_000_000,
      log,
    })

    const result = await convergence.converge({ activeJournalIds: [] })
    expect(result).toEqual({ failed: 1, rolledForward: 0 })
    expect(compensations).toBe(0)
    expect(
      fake.statements.some(
        (statement) =>
          statement.toLowerCase().includes('update "agent_workflow"."intent_apply_journal"') &&
          statement.toLowerCase().includes('returning "id"'),
      ),
    ).toBe(true)
  })

  test('active or fresh journals are never reaped by maintenance', async () => {
    const fake = fixture(999_999)
    const convergence = createPostgresqlIntentApplyJournalConvergence({
      db: fake.db,
      artifacts: {
        async compensate() {
          throw new Error('active journal must not compensate')
        },
        async rollForward() {
          throw new Error('active journal must not roll forward')
        },
      },
      now: () => 1_000_000,
      log,
    })
    await expect(convergence.converge({ activeJournalIds: ['journal-1'] })).resolves.toEqual({
      failed: 0,
      rolledForward: 0,
    })
    expect(fake.statements.some((statement) => statement.toLowerCase().startsWith('update'))).toBe(
      false,
    )
  })
})
