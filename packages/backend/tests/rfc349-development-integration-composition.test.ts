import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { composePostgresqlDevelopmentToolConnectionCatalog } from '@/modules/integration/composition/digitalEmployeeToolConnections'
import { createPostgresqlDevelopmentAdapterRevisionStore } from '@/modules/integration/infrastructure/postgresqlDevelopmentAdapterRevisionStore'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

function rows(values: readonly (readonly unknown[])[] = []): SqlRows {
  const objects = [] as Array<Record<string, unknown>> & { count?: number }
  objects.count = 0
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return values
    },
  })
}

function fixture() {
  const statements: string[] = []
  const contentJson = JSON.stringify({
    schemaVersion: 1,
    purpose: 'pipeline-gate',
    operations: ['collect'],
    contractVersion: 1,
    executableRef: 'fixture-pipeline',
    parameterSchemaRef: null,
    connectionRef: null,
    secretProjection: [],
    outputBudget: { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096 },
    timeoutMs: 10_000,
  })
  const execute = (sql: string): SqlRows => {
    statements.push(sql)
    if (sql.includes('development_adapter_definition_revisions')) {
      return rows([[contentJson, 'digest-1']])
    }
    if (sql.includes('development_adapter_definitions')) {
      return rows([
        ['adapter-1', 'CI gate', '{}', 1, 'owner-1', 'public', 0, 100, 100, null, 'pipeline-gate'],
      ])
    }
    throw new Error(`unexpected PostgreSQL development adapter query: ${sql}`)
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
    generationId: 'dbg_development_composition_pg',
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

describe('RFC-349 Development and Integration provider composition', () => {
  test('PostgreSQL revision and connection catalogs execute through the async provider', async () => {
    const fake = fixture()
    const revisions = createPostgresqlDevelopmentAdapterRevisionStore(fake.db)
    await expect(revisions.getRevision('adapter-1', 1)).resolves.toEqual({
      contentJson: expect.any(String),
      contentDigest: 'digest-1',
    })

    const catalog = composePostgresqlDevelopmentToolConnectionCatalog(fake.db)
    await expect(catalog.resolve({ id: 'adapter-1', revision: 1 })).resolves.toMatchObject({
      ref: { id: 'adapter-1', revision: 1 },
      purpose: 'pipeline-gate',
      available: true,
      visible: true,
      contentDigest: 'digest-1',
    })
    expect(fake.statements.every((statement) => statement.includes('agent_workflow'))).toBe(true)
  })

  test('every PostgreSQL composition names its provider adapter instead of aliasing SQLite', () => {
    const files = [
      'modules/integration/composition/pipelineEvidence.ts',
      'modules/integration/composition/requirementSource.ts',
      'modules/integration/composition/approvalGateway.ts',
      'modules/integration/composition/digitalEmployeeToolConnections.ts',
      'modules/development-automation/composition/digitalEmployeeWorkspace.ts',
      'modules/development-automation/composition/digitalEmployeePlatformWorkItems.ts',
      'modules/development-automation/composition/executionTerminalObserver.ts',
      'modules/development-automation/composition/legacyMissionDrain.ts',
    ]
    for (const file of files) {
      const source = readFileSync(resolve(import.meta.dir, '..', 'src', file), 'utf8')
      expect(source, file).toMatch(/(?:compose|create)Postgresql/)
      expect(source, file).not.toMatch(
        /(?:compose|create)Postgresql[A-Za-z0-9_]*[^{]*\{[^}]*return\s+(?:compose|create)Sqlite/s,
      )
    }
  })
})
