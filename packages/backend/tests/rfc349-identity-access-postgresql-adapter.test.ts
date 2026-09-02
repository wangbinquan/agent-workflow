// RFC-349 — PostgreSQL identity-access reads and writes use a reserved async
// transaction while the WS authority fence stays synchronous and fail closed.

import { afterEach, describe, expect, test } from 'bun:test'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import {
  PostgresqlAuthorityFenceCache,
  PostgresqlUserAccessRepository,
  PostgresqlUserAccessTransactionRunner,
} from '@/modules/identity-access/infrastructure/postgresqlUserAccessRepository'
import { UserAccessError } from '@/modules/identity-access/public/types'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

interface Response {
  readonly objects?: readonly Record<string, unknown>[]
  readonly values?: readonly (readonly unknown[])[]
  readonly count?: number
  readonly error?: Error & { code?: string }
}

function rows(response: Response): SqlRows {
  if (response.error !== undefined) {
    return Object.assign(Promise.reject(response.error), {
      async values() {
        throw response.error
      },
    })
  }
  const objects = [...(response.objects ?? [])] as Array<Record<string, unknown>> & {
    count?: number
  }
  objects.count = response.count ?? objects.length
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return response.values ?? []
    },
  })
}

function fixture(responses: Response[]) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  let releases = 0
  const run = (query: string, parameters?: readonly unknown[]) => {
    executions.push({ sql: query, parameters })
    // RFC-349: the one-shot live-write marker and the per-transaction
    // generation fence are infrastructure, not part of the adapter contract
    // each case queues responses for. Answer them without consuming the queue.
    if (query.includes('database_generations'))
      return rows({ objects: [{ generation_id: 'dbg_identity_pg' }] })
    return rows(responses.shift() ?? {})
  }
  const connection: PostgresqlReservedConnection = {
    unsafe: run,
    release() {
      releases += 1
    },
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: run,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_identity_pg',
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
  return {
    db: createPostgresqlDatabaseClient(runtime),
    executions,
    get releases() {
      return releases
    },
  }
}

const USER_VALUES = [
  'user-1',
  'alice',
  'alice@example.com',
  'Alice',
  'Alice Git',
  null,
  'user',
  'active',
  false,
  null,
  1,
  1,
  null,
  1,
  4,
] as const

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL identity-access adapter', () => {
  test('public directory applies provider-neutral search and preserves lookup order', async () => {
    const fake = fixture([
      {
        values: [['user-1', 'alice', 'Alice', 'user', 'active']],
      },
      {
        values: [
          ['user-1', 'alice', 'Alice', 'user', 'active'],
          ['user-2', 'archived', 'Archived', 'user', 'disabled'],
        ],
      },
    ])
    const repository = new PostgresqlUserAccessRepository(fake.db)

    await expect(
      repository.search({ q: 'a', limit: 10, excludeIds: ['other'], status: undefined }),
    ).resolves.toEqual([
      { id: 'user-1', username: 'alice', displayName: 'Alice', role: 'user', status: 'active' },
    ])
    await expect(repository.lookup(['user-2', 'missing', 'user-1'])).resolves.toEqual([
      {
        id: 'user-2',
        username: 'archived',
        displayName: 'Archived',
        role: 'user',
        status: 'disabled',
      },
      { id: 'user-1', username: 'alice', displayName: 'Alice', role: 'user', status: 'active' },
    ])

    expect(fake.executions[0]?.sql).toContain('lower("agent_workflow"."users"."username")')
    expect(fake.executions[1]?.sql).toContain(' in (')
  })

  test('async read warms the synchronous fail-closed authority fence', async () => {
    const fake = fixture([{ values: [[...USER_VALUES, 'user-1', 'scripts:author', null, 1]] }])
    const cache = new PostgresqlAuthorityFenceCache()
    const repository = new PostgresqlUserAccessRepository(fake.db, cache)

    expect(repository.readAuthorityFence('user-1')).toBeNull()
    await expect(repository.findAccessSnapshot('user-1')).resolves.toMatchObject({
      user: { id: 'user-1', status: 'active', accessRevision: 4 },
      grants: [{ userId: 'user-1', permission: 'scripts:author' }],
    })
    expect(repository.readAuthorityFence('user-1')).toEqual({
      status: 'active',
      accessRevision: 4,
    })
    expect(fake.executions[0]?.sql).toContain('from "agent_workflow"."users"')
  })

  test('runs pure decision and CAS persistence in one serializable reserved transaction', async () => {
    const fake = fixture([{}, {}, { values: [USER_VALUES] }, { count: 1 }, {}])
    const cache = new PostgresqlAuthorityFenceCache()
    const runner = new PostgresqlUserAccessTransactionRunner(fake.db, cache)

    const result = await runner.run({ userIds: ['user-1'] }, (transaction) => {
      const current = transaction.findUser('user-1')!
      expect(
        transaction.updateUserConditional({
          id: current.id,
          expectedAccessRevision: current.accessRevision,
          accessChanged: true,
          values: { displayName: 'Updated', accessRevision: 5, updatedAt: 2 },
        }),
      ).toBe(true)
      return 'committed'
    })

    expect(result).toBe('committed')
    expect(cache.readAuthorityFence('user-1')).toEqual({ status: 'active', accessRevision: 5 })
    expect(fake.executions.map((execution) => execution.sql.trim().toLowerCase())).toEqual([
      'begin',
      'set transaction isolation level serializable',
      expect.stringContaining('from "agent_workflow"."users"'),
      expect.stringContaining('with marked as (update "agent_workflow_meta"'),
      expect.stringContaining('select generation_id from "agent_workflow_meta"'),
      expect.stringContaining('update "agent_workflow"."users"'),
      'commit',
    ])
    // +1 reserved session: the one-shot RFC-349 live-write marker.
    expect(fake.releases).toBe(2)
  })

  test('undeclared decision reads fail closed before persistence', async () => {
    const fake = fixture([{}, {}, { values: [USER_VALUES] }, {}])
    const runner = new PostgresqlUserAccessTransactionRunner(
      fake.db,
      new PostgresqlAuthorityFenceCache(),
    )

    await expect(
      runner.run({ userIds: ['user-1'] }, (transaction) =>
        transaction.findUserByEmail('alice@example.com'),
      ),
    ).rejects.toThrow('was not declared in the transaction read-set')
    expect(fake.executions.at(-1)?.sql.trim().toLowerCase()).toBe('rollback')
    expect(fake.releases).toBe(1)
  })

  test('maps PostgreSQL uniqueness races to the closed profile error contract', async () => {
    const duplicateEmail = Object.assign(
      new Error('duplicate key value violates unique constraint "users_email_unique"'),
      { code: '23505', constraint: 'users_email_unique' },
    )
    const fake = fixture([{}, {}, { values: [USER_VALUES] }, { error: duplicateEmail }, {}])
    const runner = new PostgresqlUserAccessTransactionRunner(
      fake.db,
      new PostgresqlAuthorityFenceCache(),
    )

    const error = await runner
      .run({ operation: 'update-own-profile', userIds: ['user-1'] }, (transaction) => {
        transaction.updateUserConditional({
          id: 'user-1',
          expectedAccessRevision: 4,
          accessChanged: false,
          values: { email: 'occupied@example.com', updatedAt: 2 },
        })
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(UserAccessError)
    expect(error).toMatchObject({ kind: 'conflict', code: 'profile-email-conflict' })
    expect(fake.executions.at(-1)?.sql.trim().toLowerCase()).toBe('rollback')
  })

  test('maps a concurrent PostgreSQL username insert to username-taken', async () => {
    const duplicateUsername = Object.assign(
      new Error('duplicate key value violates unique constraint "users_username_unique"'),
      { code: '23505', constraint: 'users_username_unique' },
    )
    const fake = fixture([{}, {}, { values: [USER_VALUES] }, { error: duplicateUsername }, {}])
    const runner = new PostgresqlUserAccessTransactionRunner(
      fake.db,
      new PostgresqlAuthorityFenceCache(),
    )

    const error = await runner
      .run({ operation: 'create-managed-user', userIds: ['user-1'] }, (transaction) => {
        transaction.insertUser({
          id: 'user-2',
          username: 'alice',
          email: null,
          displayName: 'Duplicate',
          gitName: 'Duplicate',
          passwordHash: null,
          role: 'user',
          status: 'active',
          forcePasswordChange: false,
          createdBy: 'user-1',
          createdAt: 2,
          updatedAt: 2,
          lastLoginAt: null,
          schemaVersion: 1,
          accessRevision: 0,
        })
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(UserAccessError)
    expect(error).toMatchObject({ kind: 'conflict', code: 'username-taken' })
    expect(fake.executions.at(-1)?.sql.trim().toLowerCase()).toBe('rollback')
  })
})
