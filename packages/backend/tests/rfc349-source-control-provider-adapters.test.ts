// RFC-349 — source-control credential persistence runs through the same closed
// Promise repository on SQLite and PostgreSQL; provider clients never escape
// infrastructure and PostgreSQL writes retain the live-generation fence.

import { afterEach, describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'

import { createSecretBoxFromKey } from '@/auth/secretBox'
import { createInMemoryDb } from '@/db/client'
import { codeHostConnections, repositoryTransportConnections, users } from '@/db/schema'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { RepositoryTransportCredentials } from '@/modules/source-control/application/repositoryTransportCredentials'
import { PostgresqlRepositoryTransportCredentialRepository } from '@/modules/source-control/infrastructure/postgresqlRepositoryTransportCredentialRepository'
import { SQLiteRepositoryTransportCredentialRepository } from '@/modules/source-control/infrastructure/sqliteRepositoryTransportCredentialRepository'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { createCodeHostConnectionsService } from '@/services/codeHost/connections'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DIGEST = 'a'.repeat(64)

function rows(
  values: readonly (readonly unknown[])[],
  direct: readonly Record<string, unknown>[] = [],
): SqlRows {
  return Object.assign(Promise.resolve(direct), {
    async values() {
      return values
    },
  })
}

function postgresqlFixture(responses: Array<readonly (readonly unknown[])[]>) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const execute = (query: string, parameters?: readonly unknown[]): SqlRows => {
    executions.push({ sql: query, parameters })
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(query)) return rows([])
    if (query.includes('database_generations')) {
      return rows([], [{ generation_id: 'dbg_source_control_pg' }])
    }
    const response = responses.shift() ?? []
    const mutation = /^\s*(DELETE|INSERT|UPDATE)/i.test(query)
    return rows(response, mutation ? [{}] : [])
  }
  const connection: PostgresqlReservedConnection = {
    unsafe: execute,
    release() {},
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
    generationId: 'dbg_source_control_pg',
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
    repository: new PostgresqlRepositoryTransportCredentialRepository(
      createPostgresqlDatabaseClient(runtime),
    ),
    executions,
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 source-control provider adapters', () => {
  test('SQLite adapter preserves the sealed credential behavior behind Promise methods', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 49))
    const repository = new SQLiteRepositoryTransportCredentialRepository(db)
    const credentials = new RepositoryTransportCredentials(repository, secretBox)
    const user = { id: 'rfc349-source-control-user' }
    db.insert(users)
      .values({
        id: user.id,
        username: 'rfc349-source-control-sqlite',
        displayName: 'SQLite Source Control',
        role: 'user',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      })
      .run()

    await credentials.synchronize({
      provider: 'gitlab',
      connectionGeneration: 'generation-1',
      endpointBindingDigest: DIGEST,
      apiBaseUrl: 'https://git.example.test/api/v4',
      rejectUnauthorized: true,
      transportMappings: [],
      allowedHttpBaseUrls: ['https://git.example.test'],
      globalTokenEnc: secretBox.seal('global-source-control-token'),
      globalTokenHint: 'oken',
      updatedAt: 1,
      updatedBy: null,
    })
    await credentials.put({ kind: 'user', userId: user.id }, 'gitlab', {
      token: 'personal-source-control-token',
      connectionGeneration: 'generation-1',
      endpointBindingDigest: DIGEST,
    })

    await expect(
      credentials.resolveExecution({ kind: 'user', userId: user.id }, 'gitlab'),
    ).resolves.toMatchObject({
      ok: true,
      credential: { credentialSource: 'personal', token: 'personal-source-control-token' },
    })
    await expect(credentials.list({ kind: 'user', userId: user.id })).resolves.toMatchObject({
      items: [{ provider: 'gitlab', configured: true, stale: false }],
    })
  })

  test('administrator connection and publication projection commit atomically behind the participant', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 50))
    const repository = new SQLiteRepositoryTransportCredentialRepository(db)
    const credentials = new RepositoryTransportCredentials(repository, secretBox)
    const service = createCodeHostConnectionsService({
      secretBox,
      repositoryTransport: credentials,
    })

    db.$client.exec(`
      CREATE TRIGGER rfc349_fail_repository_projection
      BEFORE INSERT ON repository_transport_connections
      BEGIN
        SELECT RAISE(ABORT, 'projection unavailable');
      END;
    `)
    await expect(
      service.upsert('gitlab', {
        baseUrl: 'https://git.example.test/api/v4',
        token: 'atomic-source-control-token',
      }),
    ).rejects.toThrow('projection unavailable')
    expect(db.select().from(codeHostConnections).all()).toEqual([])
    expect(db.select().from(repositoryTransportConnections).all()).toEqual([])

    db.$client.exec('DROP TRIGGER rfc349_fail_repository_projection')
    await service.upsert('gitlab', {
      baseUrl: 'https://git.example.test/api/v4',
      token: 'atomic-source-control-token',
    })
    await expect(service.resolve('gitlab')).resolves.toMatchObject({
      provider: 'gitlab',
      baseUrl: 'https://git.example.test/api/v4',
      token: 'atomic-source-control-token',
    })
    expect(db.select().from(codeHostConnections).all()).toHaveLength(1)
    expect(db.select().from(repositoryTransportConnections).all()).toHaveLength(1)

    const current = await credentials.findAdminConnection('gitlab')
    expect(current).not.toBeNull()
    await expect(
      credentials.synchronizeAdminConnection(
        { ...current!, baseUrl: 'https://stale-writer.example/api/v4' },
        {
          personalCredentialCount: 0,
          currentConnectionGeneration: null,
          currentEndpointBindingDigest: null,
        },
      ),
    ).resolves.toBe(false)
    expect(db.select().from(codeHostConnections).get()?.baseUrl).toBe(
      'https://git.example.test/api/v4',
    )
  })

  test('PostgreSQL adapter maps closed projections without exposing its provider client', async () => {
    const fake = postgresqlFixture([
      [
        [
          'gitlab',
          'generation-1',
          DIGEST,
          'https://git.example.test/api/v4',
          true,
          '[]',
          '["https://git.example.test"]',
          'sealed-global',
          'obal',
          3,
          10,
          null,
        ],
      ],
      [['user-1', 'gitlab', 'generation-1', DIGEST, 'sealed-personal', 'onal', 2, 8, 11]],
      [
        [
          'github',
          'https://api.github.com',
          '[]',
          '[]',
          'github-generation',
          true,
          'sealed-github',
          'thub',
          null,
          12,
          'admin-1',
        ],
      ],
    ])

    await expect(fake.repository.listConnections()).resolves.toMatchObject([
      {
        provider: 'gitlab',
        connectionGeneration: 'generation-1',
        rejectUnauthorized: true,
        credentialRevision: 3,
      },
    ])
    await expect(fake.repository.findPersonal('user-1', 'gitlab')).resolves.toMatchObject({
      credentialRef: 'personal:user-1:gitlab:2',
      tokenHint: 'onal',
    })
    await expect(fake.repository.listConfiguredConnections()).resolves.toMatchObject([
      {
        provider: 'github',
        baseUrl: 'https://api.github.com',
        connectionGeneration: 'github-generation',
      },
    ])
    expect(fake.executions.every((execution) => !execution.sql.includes('db.sqlite'))).toBe(true)
    expect(fake.executions.some((execution) => execution.sql.includes('agent_workflow'))).toBe(true)
  })

  test('PostgreSQL projection replacement revokes stale personal rows in one fenced transaction', async () => {
    const fake = postgresqlFixture([
      [
        [
          'gitlab',
          'old-generation',
          'b'.repeat(64),
          'https://old.example/api/v4',
          true,
          '[]',
          '[]',
          'sealed-old',
          'd-old',
          2,
          1,
          null,
        ],
      ],
      [],
      [],
    ])

    await fake.repository.synchronizeConnection({
      provider: 'gitlab',
      connectionGeneration: 'new-generation',
      endpointBindingDigest: DIGEST,
      apiBaseUrl: 'https://new.example/api/v4',
      rejectUnauthorized: true,
      transportMappings: [],
      allowedHttpBaseUrls: ['https://new.example'],
      globalTokenEnc: 'sealed-new',
      globalTokenHint: '-new',
      updatedAt: 2,
      updatedBy: 'admin-1',
    })

    const sql = fake.executions.map((execution) => execution.sql)
    expect(sql[0]?.toUpperCase()).toBe('BEGIN')
    expect(sql.some((statement) => statement.startsWith('delete from'))).toBe(true)
    expect(sql.some((statement) => statement.includes('on conflict'))).toBe(true)
    expect(sql.filter((statement) => statement.includes('database_generations'))).toHaveLength(2)
    expect(sql.at(-1)?.toUpperCase()).toBe('COMMIT')
  })

  test('PostgreSQL administrator write and publication projection share one fenced transaction', async () => {
    const fake = postgresqlFixture([[], [[0]], []])
    await fake.repository.synchronizeConfiguredConnection(
      {
        provider: 'github',
        baseUrl: 'https://api.github.com',
        repositoryUrlPrefixesJson: '[]',
        transportMappingsJson: '[]',
        connectionGeneration: 'github-generation',
        rejectUnauthorized: true,
        tokenEnc: 'sealed-github',
        tokenHint: 'thub',
        lastTestJson: null,
        updatedAt: 12,
        updatedBy: 'admin-1',
      },
      {
        provider: 'github',
        connectionGeneration: 'github-generation',
        endpointBindingDigest: DIGEST,
        apiBaseUrl: 'https://api.github.com',
        rejectUnauthorized: true,
        transportMappings: [],
        allowedHttpBaseUrls: ['https://github.com'],
        globalTokenEnc: 'sealed-github',
        globalTokenHint: 'thub',
        updatedAt: 12,
        updatedBy: 'admin-1',
      },
      {
        personalCredentialCount: 0,
        currentConnectionGeneration: null,
        currentEndpointBindingDigest: null,
      },
    )

    const sql = fake.executions.map((execution) => execution.sql)
    expect(sql[0]?.toUpperCase()).toBe('BEGIN')
    expect(
      sql.some(
        (statement) =>
          statement.startsWith('insert into') && statement.includes('code_host_connections'),
      ),
    ).toBe(true)
    expect(
      sql.some(
        (statement) =>
          statement.startsWith('insert into') &&
          statement.includes('repository_transport_connections'),
      ),
    ).toBe(true)
    expect(sql.at(-1)?.toUpperCase()).toBe('COMMIT')
  })
})
