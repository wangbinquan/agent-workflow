import { afterEach, describe, expect, test } from 'bun:test'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { composePostgresqlSkillMemoryFusionParticipantFactory } from '@/modules/memory/composition'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

function sqlRows(
  records: readonly Record<string, unknown>[] = [],
  values: readonly (readonly unknown[])[] = [],
): SqlRows {
  return Object.assign(Promise.resolve(records), {
    async values() {
      return values
    },
  })
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL Skill-memory fusion participant', () => {
  test('clears newer fusion provenance inside the caller-reserved transaction', async () => {
    const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
    const run = (sql: string, parameters?: readonly unknown[]) => {
      executions.push({ sql, parameters })
      if (sql.includes('database_generations')) {
        return sqlRows([{ generation_id: 'dbg_memory_fusion' }])
      }
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim())) return sqlRows()
      if (/^update/i.test(sql.trim()) && sql.includes('"agent_workflow"."memories"')) {
        return sqlRows([], [['memory-b'], ['memory-a']])
      }
      return sqlRows()
    }
    const connection: PostgresqlReservedConnection = { unsafe: run, release() {} }
    const pool: PostgresqlPool = {
      async reserve() {
        return connection
      },
      unsafe: run,
      async close() {},
    }
    const runtime: PostgresqlDatabaseRuntime = {
      provider: 'postgresql',
      generationId: 'dbg_memory_fusion',
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
    const db = createPostgresqlDatabaseClient(runtime)
    const factory = composePostgresqlSkillMemoryFusionParticipantFactory()

    const ids = await db.transaction(async (transaction) =>
      factory.inTransaction(transaction).unfuseAboveVersion({
        skillId: 'skill-1',
        aboveVersion: 3,
      }),
    )

    expect(ids).toEqual(['memory-a', 'memory-b'])
    const update = executions.find(
      (entry) =>
        /^update/i.test(entry.sql.trim()) && entry.sql.includes('"agent_workflow"."memories"'),
    )
    expect(update?.sql).toContain('"fused_into_skill_version" >')
    expect(update?.parameters).toContain('skill-1')
    expect(update?.parameters).toContain(3)
    expect(executions.filter((entry) => /^BEGIN$/i.test(entry.sql.trim()))).toHaveLength(1)
    expect(executions.filter((entry) => /^COMMIT$/i.test(entry.sql.trim()))).toHaveLength(1)
  })
})
