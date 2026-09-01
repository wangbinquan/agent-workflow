// RFC-349 — owner projections and owner/name conflicts are provider-neutral;
// SQL remains in Identity Access infrastructure.

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { users } from '@/db/schema'
import { createOwnerIdentityQueries } from '@/modules/identity-access/application/ports/ownerIdentityQueries'
import {
  composePostgresqlOwnerIdentityQueries,
  composeSqliteOwnerIdentityQueries,
} from '@/modules/identity-access/composition/providerOperations'
import { isOwnerScopedNameConflict } from '@/modules/identity-access/public/operations'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function source(relativePath: string): string {
  return readFileSync(resolve(import.meta.dir, '..', relativePath), 'utf8')
}

function rows(values: readonly (readonly unknown[])[] = []): SqlRows {
  return Object.assign(Promise.resolve([]), {
    async values() {
      return values
    },
  })
}

function postgresqlFixture() {
  const executions: string[] = []
  const execute = (query: string): SqlRows => {
    executions.push(query)
    if (query.toLowerCase().includes('from "agent_workflow"."users"')) {
      return rows([['owner-pg', 'owner-pg', 'PostgreSQL Owner']])
    }
    return rows()
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
    generationId: 'dbg_owner_identity_pg',
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
  return { db: createPostgresqlDatabaseClient(runtime), executions }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 owner identity provider seam', () => {
  test('application owns filtering, bounded batches and malformed-row degradation', async () => {
    const batches: string[][] = []
    const queries = createOwnerIdentityQueries({
      systemUserId: '__system__',
      persistence: {
        async listByIds(ids) {
          batches.push([...ids])
          return ids.map((id) => ({
            id,
            username: id === 'owner-200' ? '' : id,
            displayName: `Owner ${id}`,
          }))
        },
      },
    })
    const ids = Array.from({ length: 201 }, (_, index) => `owner-${index}`)
    const result = await queries.loadOwnerIdentities([
      null,
      undefined,
      '__system__',
      ...ids,
      'owner-0',
    ])

    expect(batches.map((batch) => batch.length)).toEqual([200, 1])
    expect(result.size).toBe(200)
    expect(result.has('owner-200')).toBe(false)
  })

  test('SQLite and PostgreSQL expose the same Promise query contract', async () => {
    const sqlite = createInMemoryDb(MIGRATIONS, { bootstrap: 'ready' })
    await sqlite.insert(users).values({
      id: 'owner-sqlite',
      username: 'owner-sqlite',
      displayName: 'SQLite Owner',
      createdAt: 1,
      updatedAt: 1,
    })
    const sqliteQueries = composeSqliteOwnerIdentityQueries(sqlite)
    await expect(sqliteQueries.loadOwnerIdentities(['owner-sqlite'])).resolves.toMatchObject(
      new Map([
        [
          'owner-sqlite',
          { id: 'owner-sqlite', username: 'owner-sqlite', displayName: 'SQLite Owner' },
        ],
      ]),
    )

    const postgresql = postgresqlFixture()
    const postgresqlQueries = composePostgresqlOwnerIdentityQueries(postgresql.db)
    await expect(postgresqlQueries.loadOwnerIdentities(['owner-pg'])).resolves.toMatchObject(
      new Map([
        ['owner-pg', { id: 'owner-pg', username: 'owner-pg', displayName: 'PostgreSQL Owner' }],
      ]),
    )
    expect(postgresql.executions.some((query) => query.includes('agent_workflow'))).toBe(true)
  })

  test('conflict classifier preserves SQLite errors and recognizes PostgreSQL 23505 metadata', () => {
    const target = { table: 'skills', indexName: 'skills_owner_name_unique' }
    expect(
      isOwnerScopedNameConflict(
        new Error('UNIQUE constraint failed: index skills_owner_name_unique'),
        target,
      ),
    ).toBe(true)
    expect(
      isOwnerScopedNameConflict(
        { code: '23505', constraint: 'skills_owner_name_unique', table: 'skills' },
        target,
      ),
    ).toBe(true)
    expect(
      isOwnerScopedNameConflict(
        { cause: { code: '23505', constraint: 'other_unique', table: 'skills' } },
        target,
      ),
    ).toBe(false)
  })

  test('legacy service facades own no database mechanism', () => {
    for (const relativePath of [
      'src/services/ownerIdentity.ts',
      'src/services/ownerScopedName.ts',
    ]) {
      const text = source(relativePath)
      for (const forbidden of [
        "from '@/db/",
        "from 'drizzle-orm'",
        "from 'drizzle-orm/",
        '.select(',
        '.where(',
      ]) {
        expect(text).not.toContain(forbidden)
      }
    }
  })
})
