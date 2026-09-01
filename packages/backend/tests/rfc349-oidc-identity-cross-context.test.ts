// RFC-349 — OIDC provisioning owns a provider-neutral cross-context port.
// PostgreSQL stages user access, identity linkage, and profile reconciliation
// against one synchronous TransactionScope, then flushes on one reserved
// serializable connection.

import { afterEach, describe, expect, test } from 'bun:test'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import type { OidcIdentityProfileAccess } from '@/modules/identity-access/application/ports/oidcIdentityCrossContext'
import {
  composePostgresqlOidcIdentityOperations,
  createPostgresqlIdentityAccessCrossContextBindings,
} from '@/modules/identity-access/infrastructure/postgresqlOidcIdentityCrossContext'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { DomainError } from '@/util/errors'

interface Response {
  readonly objects?: readonly Record<string, unknown>[]
  readonly values?: readonly (readonly unknown[])[]
  readonly count?: number
  readonly error?: Error & { code?: string }
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
    generationId: 'dbg_oidc_identity_pg',
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

function profileAccess(): OidcIdentityProfileAccess {
  const bindings = createPostgresqlIdentityAccessCrossContextBindings()
  return Object.freeze({
    ...bindings,
    syncOidcProfile: Object.freeze({
      async execute() {
        throw new Error('out-of-transaction profile sync was not expected')
      },
    }),
    mapOidcEmailConstraint(error: unknown) {
      return error
    },
  })
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL OIDC identity cross-context transaction', () => {
  test('selector drift rolls back before identity or user side effects', async () => {
    const fake = fixture([
      {},
      {},
      { values: [] },
      { values: [] },
      { values: [['uid', 'preferred_username', 'name', 'email']] },
      {},
    ])
    const identities = composePostgresqlOidcIdentityOperations({
      db: fake.db,
      identityAccess: profileAccess(),
    })

    const error = await identities
      .createIdentity({
        userId: 'user-1',
        providerId: 'provider-1',
        subject: 'subject-1',
        email: null,
        emailVerified: false,
        displayName: 'Alice',
        gitName: 'Alice Git',
        preferredSnapshot: 'Alice',
        expectedSubjectClaim: 'sub',
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({ code: 'provider-config-changed' })
    expect(fake.executions.map((execution) => execution.sql.trim().toLowerCase())).toEqual([
      'begin',
      'set transaction isolation level serializable',
      expect.stringContaining('from "agent_workflow"."users"'),
      expect.stringContaining('from "agent_workflow"."user_identities"'),
      expect.stringContaining('from "agent_workflow"."oidc_providers"'),
      'rollback',
    ])
    expect(fake.executions.every((execution) => execution.client === 'reserved')).toBe(true)
    expect(
      fake.executions.some((execution) =>
        /^(?:insert|update|delete)\b/i.test(execution.sql.trim()),
      ),
    ).toBe(false)
    expect(fake.reserves).toBe(1)
    expect(fake.releases).toBe(1)
    expect(fake.remaining()).toBe(0)
  })

  test('user, access audit, identity, and profile seed commit on one reserved connection', async () => {
    const generation = { objects: [{ generation_id: 'dbg_oidc_identity_pg' }] }
    const fake = fixture([
      {},
      {},
      { values: [['guest']] },
      { values: [] },
      { values: [] },
      { values: [['sub', 'preferred_username', 'name', 'email']] },
      { values: [] },
      generation,
      { count: 1 },
      generation,
      { count: 1 },
      generation,
      { count: 1 },
      generation,
      { count: 1 },
      {},
    ])
    const identities = composePostgresqlOidcIdentityOperations({
      db: fake.db,
      identityAccess: profileAccess(),
    })

    const created = await identities.createUserWithIdentity({
      username: 'alice',
      displayName: 'Alice',
      gitName: 'Alice Git',
      email: null,
      now: 10,
      identity: {
        providerId: 'provider-1',
        subject: 'subject-1',
        email: null,
        emailVerified: false,
        displayName: 'Alice',
        gitName: 'Alice Git',
        // Deliberately stale so the in-transaction profile participant stages
        // a material identity update after the linkage insert.
        preferredSnapshot: '',
        expectedSubjectClaim: 'sub',
        expectedUsernameClaim: 'preferred_username',
        expectedGitNameClaim: 'name',
        expectedEmailClaim: 'email',
      },
    })

    expect(created.userId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const sql = fake.executions.map((execution) => execution.sql.trim().toLowerCase())
    expect(sql[0]).toBe('begin')
    expect(sql[1]).toBe('set transaction isolation level serializable')
    expect(sql.at(-1)).toBe('commit')
    expect(sql.filter((statement) => statement.includes('insert into'))).toEqual([
      expect.stringContaining('"agent_workflow"."users"'),
      expect.stringContaining('"agent_workflow"."user_access_audit"'),
      expect.stringContaining('"agent_workflow"."user_identities"'),
    ])
    expect(sql.filter((statement) => statement.startsWith('update '))).toEqual([
      expect.stringContaining('"agent_workflow_meta"."database_generations"'),
      expect.stringContaining('"agent_workflow_meta"."database_generations"'),
      expect.stringContaining('"agent_workflow_meta"."database_generations"'),
      expect.stringContaining('"agent_workflow_meta"."database_generations"'),
      expect.stringContaining('"agent_workflow"."user_identities"'),
    ])
    expect(fake.executions.every((execution) => execution.client === 'reserved')).toBe(true)
    expect(fake.reserves).toBe(1)
    expect(fake.releases).toBe(1)
    expect(fake.remaining()).toBe(0)
  })
})
