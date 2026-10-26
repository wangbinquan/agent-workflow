import { createEpoch2PostgresqlMetadata } from './helpers/epoch2PostgresqlMetadata'
import { withNativeTransactions } from './helpers/nativeTransactions'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { describe, expect, test } from 'bun:test'

import { composeCodeCapabilityDemoSeedParticipant } from '@/modules/code-capability/composition/demoSeed'
import { createCodeCapabilityDemoSeedParticipant } from '@/modules/code-capability/application/demoSeed'
import { createCodeCapabilityDemoSeedPersistence } from '@/modules/code-capability/infrastructure/demoSeedPersistence'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { describeEachProvider } from './helpers/eachProvider'

function rows(input: {
  readonly objects?: readonly Record<string, unknown>[]
  readonly values?: readonly (readonly unknown[])[]
  readonly count?: number
}): SqlRows {
  const objects = [...(input.objects ?? [])] as Array<Record<string, unknown>> & { count?: number }
  objects.count = input.count ?? objects.length
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return input.values ?? []
    },
  })
}

function postgresqlFixture() {
  const statements: string[] = []
  const epoch2Metadata = createEpoch2PostgresqlMetadata()
  const execute = (sql: string): SqlRows => {
    statements.push(sql)
    const metadata = epoch2Metadata(sql)
    if (metadata) return metadata
    const normalized = sql.trim().toLowerCase()
    if (/^(begin|commit|rollback)$/.test(normalized)) return rows({})
    if (sql.includes('generations')) {
      return rows({ objects: [{ generation_id: 'dbg_code_demo_seed_pg' }] })
    }
    if (normalized.startsWith('insert')) return rows({ count: 1 })
    throw new Error(`unexpected PostgreSQL demo-seed query: ${sql}`)
  }
  const connection: PostgresqlReservedConnection = withNativeTransactions({
    unsafe: execute,
    release() {},
  })
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: execute,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_code_demo_seed_pg',
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

describe('RFC-349 Code Capability demo-seed participant', () => {
  describeEachProvider('complete aggregate retry counts', (harness) => {
    test('SQLite creates the complete aggregate once and preserves stable retry counts', async () => {
      const db = harness.db
      const seed = createCodeCapabilityDemoSeedParticipant(
        createCodeCapabilityDemoSeedPersistence(db),
      )

      const first = await seed.ensure({ agentId: 'demo-agent' })
      const second = await seed.ensure({ agentId: 'demo-agent' })

      expect(second).toEqual(first)
      const { capabilityTemplates } = tablesOf(db)
      const { codeHistoryArchives, codeHistoryIdIndex } = tablesOf(db)
      expect(await db.select().from(capabilityTemplates)).toHaveLength(1)
      expect(await db.select().from(codeHistoryArchives)).toHaveLength(0)
      expect(await db.select().from(codeHistoryIdIndex)).toHaveLength(0)
      expect(first).toMatchObject({ workItemId: null, roundId: null, stageIds: [] })
    })
  })

  test('PostgreSQL commits only the template in one fenced transaction', async () => {
    const fake = postgresqlFixture()
    const receipt = await composeCodeCapabilityDemoSeedParticipant(fake.db).ensure({
      agentId: 'demo-agent',
    })

    expect(receipt.stageIds).toEqual([])
    const normalized = fake.statements.map((statement) => statement.trim().toLowerCase())
    expect(normalized[0]).toBe('begin')
    expect(normalized.at(-1)).toBe('commit')
    for (const table of ['capability_templates']) {
      const statement = normalized.find((candidate) => candidate.includes(`"${table}"`))
      expect(statement).toContain('on conflict do nothing')
    }
    expect(normalized.some((statement) => statement.includes('generations'))).toBe(true)
    expect(
      normalized.filter(
        (statement) => statement.startsWith('insert') && /code_work|code_round/.test(statement),
      ),
    ).toEqual([])
  })
})
