// RFC-349 — OIDC provider lifecycle invariants are evaluated inside the
// selected provider's own serializable transaction. PostgreSQL never consults
// a SQLite shadow while protecting the subject namespace or login families.

import { afterEach, describe, expect, test } from 'bun:test'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { PostgresqlOidcProviderRepository } from '@/modules/identity-access/infrastructure/postgresqlOidcProviderRepository'
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
  readonly valuesError?: Error & { code?: string }
}

interface Execution {
  readonly client: 'pool' | 'reserved'
  readonly sql: string
  readonly parameters?: readonly unknown[]
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
      if (response.valuesError !== undefined) throw response.valuesError
      return response.values ?? []
    },
  })
}

function fixture(responses: Response[]) {
  const executions: Execution[] = []
  let reserves = 0
  let releases = 0
  const run = (client: Execution['client'], query: string, parameters?: readonly unknown[]) => {
    executions.push({ client, sql: query, parameters })
    return rows(responses.shift() ?? {})
  }
  const connection: PostgresqlReservedConnection = {
    unsafe: (query, parameters) => run('reserved', query, parameters),
    release() {
      releases += 1
    },
  }
  const pool: PostgresqlPool = {
    async reserve() {
      reserves += 1
      return connection
    },
    unsafe: (query, parameters) => run('pool', query, parameters),
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_oidc_provider_pg',
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
    remaining: () => responses.length,
    get reserves() {
      return reserves
    },
    get releases() {
      return releases
    },
  }
}

const PROVIDER_VALUES = [
  'provider-1',
  'corp',
  'Corporate SSO',
  'https://idp.example.test',
  'client',
  'sealed-secret',
  'openid profile email',
  'auto',
  '[]',
  null,
  true,
  'https://idp.example.test/authorize',
  'https://idp.example.test/token',
  'https://idp.example.test/userinfo',
  'get_bearer',
  'https://idp.example.test/jwks',
  true,
  'preferred_username',
  'name',
  'email',
  'sub',
  1,
  1,
  1,
] as const

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL OIDC provider persistence', () => {
  test('the serializable namespace guard rejects an identity that won the subjectClaim race', async () => {
    const serializationFailure = Object.assign(new Error('could not serialize access'), {
      code: '40001',
    })
    const fake = fixture([
      {},
      {},
      { values: [PROVIDER_VALUES] },
      { valuesError: serializationFailure },
      {},
      {},
      {},
      { values: [PROVIDER_VALUES] },
      { values: [['identity-1']] },
      {},
    ])
    const repository = new PostgresqlOidcProviderRepository(fake.db)

    const result = await repository
      .patch({
        id: 'provider-1',
        updates: { subjectClaim: 'uid', updatedAt: 2 },
        subjectClaimChanges: true,
      })
      .catch((error: unknown) => error)

    expect(fake.executions.map((execution) => execution.sql.trim().toLowerCase())).toEqual([
      'begin',
      'set transaction isolation level serializable',
      expect.stringContaining('from "agent_workflow"."oidc_providers"'),
      expect.stringContaining('from "agent_workflow"."user_identities"'),
      'rollback',
      'begin',
      'set transaction isolation level serializable',
      expect.stringContaining('from "agent_workflow"."oidc_providers"'),
      expect.stringContaining('from "agent_workflow"."user_identities"'),
      'commit',
    ])
    expect(result).toEqual({ ok: false, code: 'subject-claim-locked-by-identities' })
    expect(fake.executions.every((execution) => execution.client === 'reserved')).toBe(true)
    expect(
      fake.executions.some((execution) => /update .*oidc_providers/i.test(execution.sql)),
    ).toBe(false)
    expect(fake.reserves).toBe(2)
    expect(fake.releases).toBe(2)
    expect(fake.remaining()).toBe(0)
  })

  test('last-login-family protection reads policy and other providers in the same transaction', async () => {
    const fake = fixture([
      {},
      {},
      { values: [PROVIDER_VALUES] },
      { values: [[false]] },
      { values: [] },
      {},
    ])
    const repository = new PostgresqlOidcProviderRepository(fake.db)

    await expect(
      repository.patch({
        id: 'provider-1',
        updates: { enabled: false, updatedAt: 2 },
        subjectClaimChanges: false,
      }),
    ).resolves.toEqual({ ok: false, code: 'last-enabled-oidc-required' })

    const sql = fake.executions.map((execution) => execution.sql.trim().toLowerCase())
    expect(sql).toEqual([
      'begin',
      'set transaction isolation level serializable',
      expect.stringContaining('from "agent_workflow"."oidc_providers"'),
      expect.stringContaining('from "agent_workflow"."auth_login_policy"'),
      expect.stringContaining('from "agent_workflow"."oidc_providers"'),
      'commit',
    ])
    expect(fake.executions.every((execution) => execution.client === 'reserved')).toBe(true)
    expect(sql.some((statement) => statement.startsWith('update '))).toBe(false)
    expect(fake.reserves).toBe(1)
    expect(fake.releases).toBe(1)
    expect(fake.remaining()).toBe(0)
  })
})
