// RFC-391: both engines use one passive graph; cold restore, selection admission and
// maintenance materialization protection retain their explicit behavior contracts.
import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import {
  composeDaemonApplication,
  type DaemonApplicationInput,
  type DaemonApplicationPhase,
} from '@/bootstrap/daemonApplication'
import {
  DAEMON_SESSION_ADAPTERS,
  HOSTED_ONLY_SELECTIONS,
  type DaemonSessionAdapter,
} from '@/bootstrap/daemonSessionAdapters'
import { snapshotMaintenanceTaskIds } from '@/bootstrap/daemonSession'
import {
  DAEMON_BOOT_STEPS,
  NotApplicable,
  type DaemonBootStepDeclaration,
} from '@/cli/daemonLifecycleProgram'
import * as resourceCatalog from '@/cli/daemonModules/resourceCatalog'
import { composeDatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import { materializingSpaces } from '@/services/gc'
import { DAEMON_GENERATION } from '@/services/daemonGeneration'
import { describeEachProvider, type ProviderDatabaseHarness } from './helpers/eachProvider'
import { composeUnstartedApplication } from './helpers/providerHttpApplication'
import { attachTestTaskRuntime } from './helpers/taskRuntimeRegistry'

function fixture(harness: ProviderDatabaseHarness) {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc391-'))
  const configPath = join(appHome, 'config.json')
  const unexpected = async (): Promise<never> => {
    throw new Error('migration not started by application fixture')
  }
  const databaseMigration = composeDatabaseMigrationModule({
    admission: {
      freezeAndDrain: unexpected,
      reopenSqlite: unexpected,
      activatePostgresql: unexpected,
      openPostgresqlAdmission: unexpected,
    },
    sqlitePath: join(appHome, 'db.sqlite'),
    operationsRoot: join(appHome, 'database-migrations'),
    generationPointerPath: join(appHome, 'database-generation.json'),
    configPath,
    executionMode: 'inline',
  })
  const binding = harness.applicationBinding
  const input: DaemonApplicationInput = {
    db: binding.db,
    provider:
      binding.provider === 'sqlite'
        ? {
            provider: 'sqlite',
            telemetry: () => ({ version: 1, provider: 'sqlite', poolWait: null }),
          }
        : {
            provider: 'postgresql',
            runtime: binding.runtime,
            telemetry: binding.runtime.telemetry,
          },
    config: {
      ...DEFAULT_CONFIG,
      database: binding.provider === 'sqlite' ? { provider: 'sqlite' } : binding.databaseConfig,
    },
    token: 'rfc391-token',
    appHome,
    configPath,
    daemonInfoPath: join(appHome, '.daemon.info'),
    lockPath: join(appHome, '.daemon.lock'),
    secretBox: createSecretBoxFromKey(Buffer.alloc(32, 39)),
    databaseMigration,
    dbVersion: 1,
  }
  return {
    input,
    compose: (phase: DaemonApplicationPhase, selections: Partial<DaemonApplicationInput> = {}) =>
      composeDaemonApplication({ ...input, ...selections }, phase),
    remove: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

describeEachProvider('RFC-391 neutral application and session behavior', (harness) => {
  test('the same graph supplies every applicable boot step and builds no running background work', async () => {
    const f = fixture(harness)
    const application = await composeUnstartedApplication((scope) =>
      f.compose({ kind: 'unstarted', scope }),
    )
    try {
      const declarations: readonly DaemonBootStepDeclaration[] = DAEMON_BOOT_STEPS
      expect(Object.keys(application.lifecycleSteps).sort()).toEqual(
        declarations
          .filter((step) => step.id !== 'maintenance-boot-snapshot')
          .map((step) => step.id)
          .sort(),
      )
      for (const declaration of declarations) {
        if (declaration.id === 'maintenance-boot-snapshot') continue
        const implementation =
          application.lifecycleSteps[declaration.id as keyof typeof application.lifecycleSteps]
        const applies =
          declaration.providers === undefined ||
          declaration.providers.includes(harness.applicationBinding.provider)
        expect(
          applies ? typeof implementation === 'function' : implementation === NotApplicable,
        ).toBe(true)
      }
      expect(application.runtime.taskExecutionModules.activeTaskIds()).toEqual([])
      expect(
        Object.is(application.runtime.taskExecutionModules, application.runtime.taskExecution),
      ).toBe(true)
      expect(application.runtime.collaborationContext).toBe(
        application.runtime.taskExecutionModules.collaboration,
      )
    } finally {
      await application.dispose()
      application.core.identityAccess.shutdown()
      f.remove()
    }
  })

  test('cold restore runs only in the daemon phase, after core and before resource catalog', async () => {
    const f = fixture(harness)
    const provider = harness.applicationBinding.provider
    const adapter = DAEMON_SESSION_ADAPTERS[provider] as DaemonSessionAdapter
    const events: string[] = []
    const originalCore = adapter.core
    const originalAfter = adapter.afterCore
    const core = spyOn(adapter, 'core').mockImplementation((input) => {
      events.push('core')
      const selected = originalCore(input)
      return {
        ...selected,
        systemOperations: (preparation) => {
          const operations = selected.systemOperations(preparation)
          if (!('applyPendingRestore' in operations)) return operations
          return {
            ...operations,
            applyPendingRestore: async () => {
              events.push('restore')
              await operations.applyPendingRestore()
            },
          }
        },
      }
    })
    const after = spyOn(adapter, 'afterCore').mockImplementation(async (value) => {
      events.push('after-core')
      await originalAfter(value)
    })
    const originalResources = resourceCatalog.composeDaemonResourceCatalogModules
    const resources = spyOn(
      resourceCatalog,
      'composeDaemonResourceCatalogModules',
    ).mockImplementation((input) => {
      events.push('resources')
      return originalResources(input)
    })
    try {
      const unstarted = await composeUnstartedApplication((scope) =>
        f.compose({ kind: 'unstarted', scope }),
      )
      expect(events).toEqual(['core', 'resources'])
      await unstarted.dispose()
      unstarted.core.identityAccess.shutdown()
      events.length = 0
      const daemon = await f.compose({ kind: 'daemon' })
      expect(events).toEqual(
        provider === 'postgresql'
          ? ['core', 'after-core', 'restore', 'resources']
          : ['core', 'after-core', 'resources'],
      )
      if (provider === 'postgresql') {
        expect('applyPendingRestore' in daemon.core.systemOperations).toBe(true)
      } else {
        expect('applyPendingRestore' in daemon.core.systemOperations).toBe(false)
      }
      await daemon.runtime.mcpRuntimeTests.dispose()
      daemon.core.identityAccess.shutdown()
    } finally {
      resources.mockRestore()
      after.mockRestore()
      core.mockRestore()
      f.remove()
    }
  })

  test('selection admission rejects every hosted field on SQLite and preserves the PostgreSQL receiver', () => {
    const adapter = DAEMON_SESSION_ADAPTERS[harness.applicationBinding.provider]
    for (const key of HOSTED_ONLY_SELECTIONS) {
      const selection = { [key]: {} }
      if (harness.applicationBinding.provider === 'sqlite')
        expect(() => adapter.admitSelections(selection)).toThrow(
          `hosted-deployment-requires-postgresql: ${key}`,
        )
      else expect(adapter.admitSelections(selection)).toBe(selection)
    }
  })

  test('maintenance worker database inputs preserve the original configuration sources', () => {
    const f = fixture(harness)
    try {
      const adapter = DAEMON_SESSION_ADAPTERS[
        harness.applicationBinding.provider
      ] as DaemonSessionAdapter
      const maintenance = adapter.maintenance({
        config: f.input.config,
        db: f.input.db,
        dbPath: join(f.input.appHome, 'db.sqlite'),
        migrationsFolder: 'rfc391-migrations',
        generationId: 'rfc391-generation',
      })
      const current = {
        ...f.input.config,
        database: { provider: 'sqlite' as const },
        sqlitePageCacheMib: 73,
        sqliteMmapMib: 87,
      }
      const databaseInit = maintenance.databaseInit(current)
      if (harness.applicationBinding.provider === 'sqlite') {
        expect(databaseInit).toEqual({
          dbPath: join(f.input.appHome, 'db.sqlite'),
          migrationsFolder: 'rfc391-migrations',
          sqlite: {
            synchronous: current.sqliteSynchronous,
            pageCacheMib: 73,
            mmapMib: 87,
            busyTimeoutMs: 50,
          },
        })
      } else {
        expect(databaseInit).toEqual({
          provider: 'postgresql',
          generationId: 'rfc391-generation',
          database: harness.applicationBinding.databaseConfig,
        })
      }
    } finally {
      f.remove()
    }
  })

  test('maintenance protects materializing tasks as well as this session drivers, with former wiring control', async () => {
    const f = fixture(harness)
    const application = await composeUnstartedApplication((scope) =>
      f.compose({ kind: 'unstarted', scope }),
    )
    const driver = attachTestTaskRuntime(
      application.runtime.taskExecution.executionModule,
      'rfc391-driving',
    )
    materializingSpaces.set('rfc391-materializing', { dir: f.input.appHome, startedAt: Date.now() })
    materializingSpaces.set('rfc391-driving', { dir: f.input.appHome, startedAt: Date.now() })
    try {
      const formerWiring = application.runtime.taskExecutionModules.activeTaskIds
      expect(formerWiring()).toContain('rfc391-driving')
      expect(formerWiring()).not.toContain('rfc391-materializing')
      expect(snapshotMaintenanceTaskIds(formerWiring).sort()).toEqual([
        'rfc391-driving',
        'rfc391-materializing',
      ])
      materializingSpaces.delete('rfc391-materializing')
      expect(snapshotMaintenanceTaskIds(formerWiring)).toEqual(['rfc391-driving'])
      const adapter = DAEMON_SESSION_ADAPTERS[harness.applicationBinding.provider]
      expect(adapter.recoveryProofGeneration(f.input.provider as never)).toBe(
        harness.applicationBinding.provider === 'sqlite'
          ? DAEMON_GENERATION
          : harness.applicationBinding.runtime.generationId,
      )
    } finally {
      driver.release()
      materializingSpaces.delete('rfc391-driving')
      materializingSpaces.delete('rfc391-materializing')
      await application.dispose()
      application.core.identityAccess.shutdown()
      f.remove()
    }
  })
})
