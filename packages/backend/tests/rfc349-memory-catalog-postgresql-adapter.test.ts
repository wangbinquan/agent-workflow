import { afterEach, describe, expect, test } from 'bun:test'

import { buildActor } from '@/auth/actor'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import type {
  DirectCommandContextFactory,
  RequestAuthority,
} from '@/modules/identity-access/public/participants'
import type { MemoryResourceScopeAccessParticipant } from '@/modules/memory/application/ports/resourceScopeAccess'
import { composePostgresqlMemoryCatalogOperations } from '@/modules/memory/infrastructure/postgresqlMemoryCatalogOperations'
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

function fixture(
  values: Array<readonly (readonly unknown[])[]>,
  access: 'none' | 'read' | 'write' | 'own' = 'own',
) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (sql: string, parameters?: readonly unknown[]) => {
    executions.push({ sql, parameters })
    if (sql.includes('database_generations')) return sqlRows([{ generation_id: 'dbg_memory' }])
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim())) return sqlRows()
    return sqlRows([], values.shift() ?? [])
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
    generationId: 'dbg_memory',
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
  type Transaction = Parameters<
    Parameters<ReturnType<typeof createPostgresqlDatabaseClient>['transaction']>[0]
  >[0]
  const authorization: MemoryResourceScopeAccessParticipant<Transaction> = {
    accessOf: async () => access,
  }
  const contexts = {} as DirectCommandContextFactory
  return {
    operations: composePostgresqlMemoryCatalogOperations({
      db: createPostgresqlDatabaseClient(runtime),
      contexts,
      authorization,
    }),
    executions,
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL memory catalog adapter', () => {
  test('creates a manual candidate through the generation-fenced PostgreSQL writer', async () => {
    const fake = fixture([])
    const created = await fake.operations.commands.createManual({
      scopeType: 'global',
      scopeId: null,
      title: 'Provider invariant',
      bodyMd: 'Never reopen SQLite after PostgreSQL cutover.',
      tags: ['postgresql'],
    })

    expect(created).toMatchObject({
      status: 'candidate',
      sourceKind: 'manual',
      title: 'Provider invariant',
    })
    expect(fake.executions.some((entry) => entry.sql.includes('database_generations'))).toBe(true)
    expect(fake.executions.some((entry) => entry.sql.includes('"agent_workflow"."memories"'))).toBe(
      true,
    )
  })

  test('keeps the summary read body-free and returns an empty provider-neutral list', async () => {
    const fake = fixture([[]])
    await expect(fake.operations.queries.list()).resolves.toEqual([])
    const select = fake.executions.find((entry) => /^select/i.test(entry.sql.trim()))
    expect(select?.sql).not.toContain('"body_md"')
  })

  test('projects delegated write access as memory management authority', async () => {
    const fake = fixture([], 'write')
    const authority = {
      authority: {} as RequestAuthority,
      actor: buildActor({
        user: {
          id: 'user-1',
          username: 'memory-editor',
          displayName: 'Memory editor',
          role: 'user',
          status: 'active',
        },
        source: 'session',
      }),
    }
    await expect(
      fake.operations.queries.annotateManageRights(authority, [
        { scopeType: 'agent', scopeId: 'agent-1' },
      ]),
    ).resolves.toEqual([{ scopeType: 'agent', scopeId: 'agent-1', canManage: true }])
  })
})
