// RFC-349 — runtime registry persistence is selected once at bootstrap. The
// application and HTTP surfaces consume one Promise-only closed port; SQLite
// and PostgreSQL keep provider mechanics inside infrastructure adapters.

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import {
  composePostgresqlRuntimeRegistryOperations,
  composeSqliteRuntimeRegistryOperations,
} from '@/platform/runtime-registry/composition'
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

function rows(values: readonly (readonly unknown[])[]): SqlRows {
  return Object.assign(Promise.resolve([] as readonly Record<string, unknown>[]), {
    async values() {
      return values
    },
  })
}

function postgresqlFixture() {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (query: string, parameters?: readonly unknown[]): SqlRows => {
    executions.push({ sql: query, parameters })
    if (query.toLowerCase().includes('from "agent_workflow"."runtimes"')) {
      return rows([
        [
          'runtime-pg-1',
          'pg-claude',
          'claude-code',
          '/opt/claude-pg',
          true,
          'anthropic/claude-sonnet-4-5',
          null,
          null,
          null,
          null,
          false,
          null,
          null,
          null,
          null,
          0,
          'admin-pg',
          100,
          200,
        ],
      ])
    }
    return rows([])
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
    generationId: 'dbg_runtime_registry_pg',
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
    registry: composePostgresqlRuntimeRegistryOperations(createPostgresqlDatabaseClient(runtime)),
    executions,
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 runtime registry provider operations', () => {
  test('business and HTTP surfaces contain no database mechanism', () => {
    for (const path of [
      'src/services/runtimeRegistry.ts',
      'src/routes/runtime.ts',
      'src/routes/runtimes.ts',
    ]) {
      const text = source(path)
      expect(text).not.toContain("from '@/db/")
      expect(text).not.toContain("from 'drizzle-orm'")
      expect(text).not.toContain('bun:sqlite')
    }
    expect(source('src/routes/runtime.ts')).toContain(
      'deps.runtimeRegistry.resolveRuntimeByName(rtParam)',
    )
    expect(source('src/routes/runtimes.ts')).toContain(
      'readonly runtimeRegistry: RuntimeRegistryOperations',
    )
  })

  test('SQLite composition preserves seed, CRUD, resolution and delete guards', async () => {
    const registry = composeSqliteRuntimeRegistryOperations(
      createInMemoryDb(MIGRATIONS, { bootstrap: 'ready' }),
    )
    await registry.seedBuiltinRuntimes()
    expect((await registry.listRuntimes()).map((row) => row.name).sort()).toEqual([
      'claude-code',
      'opencode',
    ])

    const created = await registry.createRuntime({
      name: 'custom-claude',
      protocol: 'claude-code',
      binaryPath: '/opt/custom-claude',
      model: 'anthropic/claude-sonnet-4-5',
    })
    expect(created).toMatchObject({ name: 'custom-claude', enabled: true })
    await expect(registry.resolveRuntimeByName('custom-claude')).resolves.toMatchObject({
      protocol: 'claude-code',
      binaryPath: '/opt/custom-claude',
      model: 'anthropic/claude-sonnet-4-5',
    })

    await registry.setRuntimeEnabled('custom-claude', false, 'opencode')
    expect((await registry.getRuntime('custom-claude'))?.enabled).toBe(false)
    await registry.deleteRuntime('custom-claude', {})
    await expect(registry.getRuntime('custom-claude')).resolves.toBeNull()
  })

  test('PostgreSQL composition resolves the same closed row without a SQLite facade', async () => {
    const fixture = postgresqlFixture()
    await expect(fixture.registry.getRuntime('pg-claude')).resolves.toMatchObject({
      id: 'runtime-pg-1',
      name: 'pg-claude',
      protocol: 'claude-code',
      binaryPath: '/opt/claude-pg',
      enabled: true,
    })
    await expect(fixture.registry.resolveRuntimeByName('pg-claude')).resolves.toMatchObject({
      name: 'pg-claude',
      protocol: 'claude-code',
      binaryPath: '/opt/claude-pg',
      model: 'anthropic/claude-sonnet-4-5',
    })
    expect(
      fixture.executions.every((execution) =>
        execution.sql.includes('"agent_workflow"."runtimes"'),
      ),
    ).toBe(true)
    expect(fixture.executions[0]?.parameters).toEqual(['pg-claude'])
  })
})
