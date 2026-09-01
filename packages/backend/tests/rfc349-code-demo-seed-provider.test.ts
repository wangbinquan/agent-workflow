import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { capabilityTemplates, codeRoundStages, codeWorkItems, codeWorkRounds } from '@/db/schema'
import {
  composePostgresqlCodeCapabilityDemoSeedParticipant,
  composeSqliteCodeCapabilityDemoSeedParticipant,
} from '@/modules/code-capability/composition/demoSeed'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

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
  const execute = (sql: string): SqlRows => {
    statements.push(sql)
    const normalized = sql.trim().toLowerCase()
    if (/^(begin|commit|rollback)$/.test(normalized)) return rows({})
    if (sql.includes('database_generations')) {
      return rows({ objects: [{ generation_id: 'dbg_code_demo_seed_pg' }] })
    }
    if (normalized.startsWith('insert')) return rows({ count: 1 })
    throw new Error(`unexpected PostgreSQL demo-seed query: ${sql}`)
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

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 Code Capability demo-seed participant', () => {
  test('SQLite creates the complete aggregate once and preserves stable retry counts', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const seed = composeSqliteCodeCapabilityDemoSeedParticipant(db)

    const first = await seed.ensure({ agentId: 'demo-agent' })
    const second = await seed.ensure({ agentId: 'demo-agent' })

    expect(second).toEqual(first)
    expect(db.select().from(capabilityTemplates).all()).toHaveLength(1)
    expect(db.select().from(codeWorkItems).all()).toHaveLength(1)
    expect(db.select().from(codeWorkRounds).all()).toHaveLength(1)
    expect(db.select().from(codeRoundStages).all()).toHaveLength(first.stageIds.length)
    expect(first.stageIds.length).toBeGreaterThan(0)
  })

  test('PostgreSQL commits template, work item, round and stages in one fenced transaction', async () => {
    const fake = postgresqlFixture()
    const receipt = await composePostgresqlCodeCapabilityDemoSeedParticipant(fake.db).ensure({
      agentId: 'demo-agent',
    })

    expect(receipt.stageIds.length).toBeGreaterThan(0)
    const normalized = fake.statements.map((statement) => statement.trim().toLowerCase())
    expect(normalized[0]).toBe('begin')
    expect(normalized.at(-1)).toBe('commit')
    for (const table of [
      'capability_templates',
      'code_work_items',
      'code_work_rounds',
      'code_round_stages',
    ]) {
      const statement = normalized.find((candidate) => candidate.includes(`"${table}"`))
      expect(statement).toContain('on conflict do nothing')
    }
    expect(normalized.some((statement) => statement.includes('database_generations'))).toBe(true)
  })
})
