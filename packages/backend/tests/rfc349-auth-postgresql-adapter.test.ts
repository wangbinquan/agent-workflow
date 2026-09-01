// RFC-349 — the PostgreSQL authentication adapter keeps network I/O async,
// reserves one connection for transactions and retains the generation fence
// on every credential write.

import { afterEach, describe, expect, test } from 'bun:test'

import { createPostgresqlAuthRuntime } from '@/auth/composition'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

function rows(
  values: readonly (readonly unknown[])[] = [],
  objects: readonly Record<string, unknown>[] = [],
): SqlRows {
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return values
    },
  })
}

function fixture() {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  let releases = 0
  const execute = (query: string, parameters?: readonly unknown[]): SqlRows => {
    executions.push({ sql: query, parameters })
    const compact = query.replace(/\s+/g, ' ')
    if (/database_generations/i.test(compact)) {
      return rows([], [{ generation_id: 'dbg_auth_pg' }])
    }
    if (
      /from "agent_workflow"\."user_sessions" .*inner join "agent_workflow"\."users"/i.test(compact)
    ) {
      return rows([
        [
          'session-1',
          'auth-user',
          'session-hash',
          'rfc349-postgresql',
          20,
          20,
          1_020,
          null,
          'auth-user',
          'auth-user',
          null,
          'Auth User',
          'Auth User',
          null,
          'user',
          'active',
          false,
          null,
          1,
          1,
          null,
          1,
          0,
        ],
      ])
    }
    if (
      /from "agent_workflow"\."user_pats" .*inner join "agent_workflow"\."users"/i.test(compact)
    ) {
      return rows([
        [
          'pat-1',
          'auth-user',
          'automation',
          'pat-hash',
          '["tasks:execute"]',
          20,
          null,
          null,
          null,
          'general',
          'auth-user',
          'auth-user',
          null,
          'Auth User',
          'Auth User',
          null,
          'user',
          'active',
          false,
          null,
          1,
          1,
          null,
          1,
          0,
        ],
      ])
    }
    if (/select .*auth_login_policy/i.test(compact)) {
      return rows([['global', true, 'user', 10, 10]])
    }
    if (/^\s*(insert|update|delete)/i.test(compact)) return rows([], [{}])
    return rows()
  }
  const connection: PostgresqlReservedConnection = {
    unsafe: execute,
    release() {
      releases += 1
    },
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: execute,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_auth_pg',
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

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL auth adapter', () => {
  test('policy reads and credential writes use the same closed Promise surface', async () => {
    const fake = fixture()
    const revocations: string[] = []
    const auth = createPostgresqlAuthRuntime({
      db: fake.db,
      onCredentialRevoked: (reason) => revocations.push(reason),
    })

    expect(auth.provider).toBe('postgresql')
    await expect(auth.getLoginPolicy()).resolves.toEqual({
      passwordLoginEnabled: true,
      oidcDefaultRole: 'user',
      bootstrapCompletedAt: 10,
      updatedAt: 10,
    })

    const created = await auth.createSession({
      userId: 'auth-user',
      userAgent: 'rfc349-postgresql',
      now: 20,
      ttlMs: 1_000,
    })
    expect(created.token).toStartWith('aws_s_')
    await auth.revokeSession(created.session.id, 21)

    const statements = fake.executions.map((execution) => execution.sql.trim().toLowerCase())
    expect(statements).toContain('begin')
    expect(statements).toContain('commit')
    expect(
      statements.filter((statement) => statement.includes('database_generations')),
    ).toHaveLength(2)
    expect(
      statements.some((statement) =>
        statement.includes('insert into "agent_workflow"."user_sessions"'),
      ),
    ).toBe(true)
    expect(
      statements.some((statement) => statement.includes('update "agent_workflow"."user_sessions"')),
    ).toBe(true)
    expect(revocations).toEqual(['session-revoked'])
    expect(fake.releases).toBe(2)
  })

  test('policy mutation is serializable and generation-fenced', async () => {
    const fake = fixture()
    const auth = createPostgresqlAuthRuntime({
      db: fake.db,
      onCredentialRevoked: () => {},
    })

    await expect(auth.setOidcDefaultRole('guest', 30)).resolves.toMatchObject({
      oidcDefaultRole: 'guest',
      updatedAt: 30,
    })
    expect(fake.executions.map((execution) => execution.sql.trim().toLowerCase())).toEqual([
      'begin',
      'set transaction isolation level serializable',
      expect.stringContaining('auth_login_policy'),
      expect.stringContaining('database_generations'),
      expect.stringContaining('update "agent_workflow"."auth_login_policy"'),
      'commit',
    ])
    expect(fake.releases).toBe(1)
  })

  test('session and PAT resolution stay atomic on one reserved connection', async () => {
    const fake = fixture()
    const auth = createPostgresqlAuthRuntime({
      db: fake.db,
      onCredentialRevoked: () => {},
    })

    await expect(
      auth.lookupActiveSessionByHash('session-hash', 21, { touch: false }),
    ).resolves.toMatchObject({
      session: { id: 'session-1', userId: 'auth-user', lastUsedAt: 20 },
      user: { id: 'auth-user', status: 'active' },
    })
    await expect(
      auth.lookupActivePatByHash('pat-hash', 21, { touch: false }),
    ).resolves.toMatchObject({
      patId: 'pat-1',
      scopes: ['tasks:execute'],
      purpose: 'general',
      user: { id: 'auth-user', status: 'active' },
    })

    const statements = fake.executions.map((execution) => execution.sql.trim().toLowerCase())
    expect(statements.filter((statement) => statement === 'begin')).toHaveLength(2)
    expect(
      statements.filter(
        (statement) => statement === 'set transaction isolation level serializable',
      ),
    ).toHaveLength(2)
    expect(statements.filter((statement) => statement === 'commit')).toHaveLength(2)
    expect(fake.releases).toBe(2)
  })
})
