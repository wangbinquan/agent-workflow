import { withNativeTransactions } from './helpers/nativeTransactions'
import { readDaemonGraphSource } from './helpers/daemonGraphSource'
// RFC-349 — runtime registry persistence is selected once at bootstrap. The
// application and HTTP surfaces consume one Promise-only closed port; SQLite
// and PostgreSQL keep provider mechanics inside infrastructure adapters.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describeEachProvider } from './helpers/eachProvider'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

function source(relativePath: string): string {
  return /(?:^|\/)bootstrap\/daemonStart\.ts$/.test(relativePath)
    ? readDaemonGraphSource()
    : readFileSync(resolve(import.meta.dir, '..', relativePath), 'utf8')
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
  const connection: PostgresqlReservedConnection = withNativeTransactions({
    unsafe: run,
    release() {},
  })
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
    registry: composeRuntimeRegistryOperations(createPostgresqlDatabaseClient(runtime)),
    executions,
  }
}

describe('RFC-349 runtime registry provider operations', () => {
  test('business and HTTP surfaces contain no database mechanism', () => {
    for (const path of [
      'src/modules/runtime-management/application/runtimeRegistry.ts',
      'src/modules/runtime-management/application/runtimeManagement.ts',
      'src/modules/runtime-management/domain/runtimeProfile.ts',
      'src/modules/runtime-management/infrastructure/http/runtimeRoutes.ts',
      'src/modules/runtime-management/infrastructure/http/runtimesRoutes.ts',
    ]) {
      const text = source(path)
      expect(text).not.toContain("from '@/db/")
      expect(text).not.toContain("from 'drizzle-orm'")
      expect(text).not.toContain('bun:sqlite')
    }
    expect(source('src/modules/runtime-management/infrastructure/http/runtimeRoutes.ts')).toContain(
      'await deps.list({',
    )
    expect(
      source('src/modules/runtime-management/infrastructure/http/runtimesRoutes.ts'),
    ).toContain('readonly profiles: RuntimeProfileCommands')
    expect(source('src/modules/runtime-management/application/runtimeManagement.ts')).toContain(
      'await registry.resolveRuntimeByName(rtParam)',
    )
    for (const path of [
      'src/modules/runtime-management/infrastructure/http/runtimeRoutes.ts',
      'src/modules/runtime-management/infrastructure/http/runtimesRoutes.ts',
    ]) {
      expect(source(path)).not.toContain("from '@/services/")
      expect(source(path)).not.toContain("from '@/platform/runtime-registry/")
    }
  })

  test('RFC-360 retires all legacy registry entries and reuses the root registry in PostgreSQL execution', () => {
    for (const path of [
      'src/services/runtimeRegistry.ts',
      'src/routes/runtime.ts',
      'src/routes/runtimes.ts',
      'src/platform/runtime-registry/composition.ts',
      'src/platform/runtime-registry/application/runtimeRegistryOperations.ts',
      'src/platform/runtime-registry/application/runtimeRegistryBoot.ts',
      'src/platform/runtime-registry/infrastructure/runtimeRegistryPersistence.ts',
      'src/modules/runtime-management/composition/runtimeRegistryCompatibility.ts',
    ])
      expect(existsSync(resolve(import.meta.dir, '..', path))).toBe(false)
    const registry = source('src/modules/runtime-management/composition/runtimeRegistry.ts')
    expect(registry).not.toContain('@/modules/resource-catalog/composition/')
    expect(registry).toContain('new DrizzleRuntimeRegistryPersistence(db, participants)')
    const provider = source('src/modules/task-execution/composition/providerRuntime.ts')
    expect(provider).not.toContain('composeRuntimeRegistryOperations')
    expect(provider).toContain('...dependencies.runtime')
    const root = source('src/bootstrap/daemonApplication.ts')
    expect(root).toContain('runtimeRegistry: core.runtimeRegistry')
    expect(root).toContain('observation: observationModules,')
    expect(source('src/bootstrap/daemonHttpComposition.ts')).toMatch(
      /runtimeRegistry:\s+runtimeManagement\.configuration satisfies RuntimeProfileConfigurationCommands/,
    )
    const config = source('src/modules/system-operations/application/applicationConfiguration.ts')
    expect(config).not.toContain('runtime-disabled')
    expect(config).toContain('deps.runtimeRegistry.validateDefaultChange(')
  })

  test('RFC-360 roots inject selection without a Task-to-RM internal provider bridge', () => {
    const adapter = source('src/modules/task-execution/composition/nodeRunRuntime.ts')
    expect(adapter).not.toContain('@/modules/runtime-management/composition/')
    expect(adapter).toContain('bindSelection(transaction, assertTaskScope)')
    expect(adapter).toContain('selection.freeze(binding.capability')
    const persistence = source('src/modules/task-execution/composition/taskExecutionPersistence.ts')
    expect(persistence).not.toContain('nodeRunRuntime:')
    for (const path of ['src/bootstrap/daemonStart.ts', 'src/bootstrap/daemonApplication.ts']) {
      const root = source(path)
      expect(root).toContain('composeDaemonTaskExecutionModules({')
      expect(root).not.toContain('nodeRunRuntime: composeNodeRunRuntimePersistence(')
    }
    const bundle = source('src/bootstrap/daemonModules/taskExecution.ts')
    expect(bundle).toContain(
      'nodeRunRuntime: composeNodeRunRuntimePersistence(db, composeRuntimeSelectionParticipantInTx)',
    )
    expect(source('src/services/nodeRunMint.ts')).not.toContain(
      'export async function resolveFrozenRuntime(',
    )
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
    expect(fixture.executions[0]?.parameters).toEqual(['pg-claude', 1])
  })
})

describeEachProvider('RFC-349 runtime registry provider operations', (harness) => {
  test('SQLite composition preserves seed, CRUD, resolution and delete guards', async () => {
    const registry = composeRuntimeRegistryOperations(harness.db)
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
})
