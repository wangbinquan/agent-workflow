// RFC-349 — token-call audit is a closed AUTH participant. Transports receive
// one Promise surface; provider SQL stays in SQLite/PostgreSQL infrastructure.

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildActor } from '@/auth/actor'
import { createPostgresqlTokenCallAudit, createSqliteTokenCallAudit } from '@/auth/composition'
import { createInMemoryDb } from '@/db/client'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
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

function patActor() {
  return buildActor({
    source: 'pat',
    patId: 'pat-rfc349-audit',
    patScopes: [],
    user: {
      id: 'audit-user',
      username: 'audit-user',
      displayName: 'Audit User',
      role: 'admin',
      status: 'active',
    },
  })
}

function rows(values: readonly (readonly unknown[])[] = []): SqlRows {
  return Object.assign(Promise.resolve([]), {
    async values() {
      return values
    },
  })
}

function postgresqlFixture() {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  let releases = 0
  const execute = (query: string, parameters?: readonly unknown[]): SqlRows => {
    executions.push({ sql: query, parameters })
    const compact = query.replace(/\s+/g, ' ').toLowerCase()
    if (compact.includes('database_generations')) {
      return Object.assign(Promise.resolve([{ generation_id: 'dbg_token_audit_pg' }]), {
        async values() {
          return []
        },
      })
    }
    if (compact.startsWith('select') && compact.includes('token_audit')) {
      if (compact.includes('"pat_id"')) {
        return rows([
          [
            'audit-pg-row',
            'pat-rfc349-audit',
            'audit-user',
            'mcp',
            'describe_capabilities',
            null,
            null,
            null,
            null,
            200,
            false,
            50,
          ],
        ])
      }
      return rows([['audit-pg-row']])
    }
    if (compact.startsWith('delete') && compact.includes('returning')) {
      return rows([['audit-pg-row']])
    }
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
    generationId: 'dbg_token_audit_pg',
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

describe('RFC-349 token-call audit provider participant', () => {
  test('legacy service is a facade and application contract has no provider handle', () => {
    const facade = source('src/services/tokenAudit.ts')
    const application = source('src/auth/application/tokenCallAudit.ts')

    for (const forbidden of ['DbClient', "from '@/db/", '.select(', '.insert(', '.update(']) {
      expect(facade).not.toContain(forbidden)
    }
    expect(facade).toContain('legacySqliteTokenCallAudit')
    expect(application).not.toContain('DbClient')
    expect(application).not.toContain('PostgresqlDatabaseClient')
    expect(application).not.toContain("from '@/db/")
    expect(application).toContain('export interface TokenCallAuditParticipant')
  })

  test('SQLite participant preserves attribution, snapshot redaction and bounded retention', async () => {
    const db = createInMemoryDb(MIGRATIONS, { bootstrap: 'ready' })
    const audit = createSqliteTokenCallAudit(db)
    const id = await audit.record(
      {
        actor: patActor(),
        channel: 'mcp',
        toolName: 'resource_write',
        resourceKind: 'mcps',
        resourceId: 'mcp-1',
        statusCode: 204,
        deletedSnapshot: {
          id: 'mcp-1',
          config: { env: { API_KEY: 'must-not-survive' } },
        },
      },
      10,
    )

    expect(id).not.toBeNull()
    await expect(audit.listForUser('audit-user')).resolves.toMatchObject([
      {
        id,
        patId: 'pat-rfc349-audit',
        userId: 'audit-user',
        channel: 'mcp',
        toolName: 'resource_write',
      },
    ])
    await expect(
      audit.pruneSlice(1, { version: 1, phase: 'snapshots', cutoff: 11 }, 20, 10),
    ).resolves.toMatchObject({
      done: false,
      cursor: { phase: 'audits', cutoff: 11 },
      counters: { snapshots: 1 },
    })
    await expect(
      audit.pruneSlice(1, { version: 1, phase: 'audits', cutoff: 11 }, 20, 10),
    ).resolves.toMatchObject({ done: true, counters: { audits: 1 } })
  })

  test('PostgreSQL uses the same Promise surface and generation-fences audit writes', async () => {
    const fake = postgresqlFixture()
    const audit = createPostgresqlTokenCallAudit(fake.db)

    const id = await audit.record(
      {
        actor: patActor(),
        channel: 'mcp',
        toolName: 'describe_capabilities',
        statusCode: 200,
      },
      50,
    )
    expect(id).not.toBeNull()
    await expect(audit.listForUser('audit-user', 25)).resolves.toMatchObject([
      {
        id: 'audit-pg-row',
        patId: 'pat-rfc349-audit',
        userId: 'audit-user',
        channel: 'mcp',
        toolName: 'describe_capabilities',
        statusCode: 200,
      },
    ])
    await expect(
      audit.pruneSlice(1, { version: 1, phase: 'audits', cutoff: 100 }, 200, 10),
    ).resolves.toMatchObject({ done: true, counters: { audits: 1 } })

    const statements = fake.executions.map((execution) => execution.sql.toLowerCase())
    expect(
      statements.some((statement) =>
        statement.includes('insert into "agent_workflow"."token_audit"'),
      ),
    ).toBe(true)
    expect(
      statements.some(
        (statement) =>
          statement.includes('from "agent_workflow"."token_audit"') &&
          statement.includes('where') &&
          statement.includes('limit'),
      ),
    ).toBe(true)
    expect(
      statements.filter((statement) => statement.includes('database_generations')).length,
    ).toBe(2)
    expect(fake.releases).toBe(2)
  })

  test('maintenance invokes the selected AUTH participant without a DB fallback', () => {
    const runner = source('src/platform/background/maintenanceJobRunner.ts')
    expect(runner).toContain('ownerCommands.tokenAudit')
    expect(runner).toContain('tokenAudit.pruneSlice(payload.retentionDays, input.cursor)')
    expect(runner).not.toContain("from '@/services/tokenAudit'")
    expect(runner).not.toContain('pruneTokenAuditSlice(db')
  })
})
