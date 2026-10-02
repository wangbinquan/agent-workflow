// Daemon database activation shares the selected configuration receiver, while
// installation effects remain independently selectable with their original ACKs.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, DatabaseConfigSchema, type Config } from '@agent-workflow/shared'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApplicationConfigurationPersistencePort } from '@/modules/system-operations/application/ports/applicationConfiguration'
import type { DatabaseInstallationPort } from '@/modules/system-operations/application/ports/databaseInstallation'
import type { DatabaseMigrationStatusView } from '@/modules/system-operations/application/databaseMigrationControlPlane'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import { prepareDaemonDatabaseProviderForBoot } from '@/modules/system-operations/composition/daemonDatabase'
import {
  createDatabaseMigrationManifest,
  databaseRollbackEligibility,
} from '@/modules/system-operations/domain/databaseMigration'
import type { DatabaseGenerationBootstrapCandidate } from '@/platform/persistence/generationValidation'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import {
  mergeValidatedConfigurationPatch,
  validateConfigurationPatch,
} from '@/platform/configuration/configurationValues'

const history = await loadPostgresqlMigrationHistory()
const target = DatabaseConfigSchema.parse({ provider: 'postgresql', poolMax: 3 })
if (target.provider !== 'postgresql') throw new Error('expected PostgreSQL target')

class Storage implements ApplicationConfigurationPersistencePort {
  current: Config = structuredClone(DEFAULT_CONFIG)
  beforeLoad?: () => void | Promise<void>
  beforeWrite?: () => void | Promise<void>
  readonly calls: string[] = []

  async load() {
    this.calls.push('load')
    await this.beforeLoad?.()
    return structuredClone(this.current)
  }

  previewPatch(patch: unknown) {
    this.calls.push('preview')
    return mergeValidatedConfigurationPatch(this.current, validateConfigurationPatch(patch))
  }

  async applyPatch(patch: unknown) {
    this.calls.push('write-enter')
    await this.beforeWrite?.()
    this.current = this.previewPatch(patch)
    this.calls.push('write-ack')
    return structuredClone(this.current)
  }
}

function selected(storage: Storage) {
  return composeApplicationConfigurationBinding({
    kind: 'selected',
    notificationKey: 'rfc370-daemon-database-selected',
    persistence: storage,
  })
}

function fixture() {
  const calls: string[] = []
  let candidate: DatabaseGenerationBootstrapCandidate = {
    kind: 'current',
    generation: {
      source: 'verified-pointer',
      payload: {
        version: 1,
        generationId: 'dbg_daemon_boot_fixture',
        provider: 'sqlite',
        operationId: null,
        schemaDigest: history.head.contract.digest,
        manifestDigest: null,
        activatedAt: 1,
      },
    },
  }
  const installation: DatabaseInstallationPort<string> = {
    async readGeneration() {
      calls.push('generation')
      return candidate
    },
    async resolveRecoverySource() {
      return history.root.contract
    },
    async listMigrations() {
      return []
    },
    async readMigration() {
      throw new Error('unexpected migration read')
    },
    async writeGeneration() {
      throw new Error('unexpected generation write')
    },
    async requireUpgradeLock() {
      calls.push('lock')
    },
    async releaseUpgradeLock() {
      calls.push('release')
    },
    async resumeMigration() {
      throw new Error('unexpected recovery')
    },
    async prepareProvider(input) {
      calls.push('prepare')
      expect(input.candidate).toBe(candidate)
      await input.advancePointer()
      return 'selected-prepared'
    },
  }
  const file = {
    config: DEFAULT_CONFIG.database,
    contract: history.head.contract,
    sqliteOptions: { migrationsFolder: 'unused-selected-migrations' },
    get sqlitePath(): string {
      throw new Error('selected installation read a local database path')
    },
    get generationPointerPath(): string {
      throw new Error('selected installation read a local pointer path')
    },
    get operationsRoot(): string {
      throw new Error('selected installation read a local migration path')
    },
    get lockPath(): string {
      throw new Error('selected installation read a local lock path')
    },
  }
  return {
    calls,
    installation,
    file,
    setCandidate(next: DatabaseGenerationBootstrapCandidate) {
      candidate = next
    },
  }
}

describe('RFC-370 daemon database selected bindings', () => {
  test('database writes await the same persistence receiver and preserve concurrent independent settings', async () => {
    const storage = new Storage()
    const binding = selected(storage)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    storage.beforeWrite = async () => {
      entered.resolve()
      await release.promise
    }
    let acknowledged = false
    const writing = binding.databaseConfiguration.write(target)
    const completion = Promise.resolve(writing).then(() => {
      acknowledged = true
    })
    try {
      await entered.promise
      expect(acknowledged).toBe(false)
      expect(await binding.databaseConfiguration.read()).toEqual(DEFAULT_CONFIG.database)
      storage.current.maxConcurrentNodes = 7
      release.resolve()
      await completion
      expect(await binding.databaseConfiguration.read()).toEqual(target)
      expect((await binding.queries.read()).maxConcurrentNodes).toBe(7)
      expect((await binding.queries.read()).database).toEqual(target)
      expect(storage.calls).toContain('write-ack')
    } finally {
      release.resolve()
      await completion
    }
  })

  test('configuration read/write failures propagate unchanged without a file fallback', async () => {
    const storage = new Storage()
    const binding = selected(storage)
    const readFailure = new Error('selected database read failed')
    const writeFailure = new Error('selected database write failed')
    storage.beforeLoad = () => {
      throw readFailure
    }
    await expect(Promise.resolve(binding.databaseConfiguration.read())).rejects.toBe(readFailure)
    storage.beforeWrite = () => {
      throw writeFailure
    }
    await expect(Promise.resolve(binding.databaseConfiguration.write(target))).rejects.toBe(
      writeFailure,
    )
    expect(storage.calls).not.toContain('write-ack')
    expect(storage.current.database).toEqual(DEFAULT_CONFIG.database)
  })

  test('selected installation retains initial configuration, receiver and release without local effects', async () => {
    const f = fixture()
    const storage = new Storage()
    const binding = selected(storage)
    const original = f.installation.prepareProvider
    f.installation.prepareProvider = async function (input) {
      expect<unknown>(this).toBe(f.installation)
      expect(input.config).toBe(f.file.config)
      return await original.call(this, input)
    }
    expect(
      await prepareDaemonDatabaseProviderForBoot({
        file: f.file,
        configuration: binding.databaseConfiguration,
        installation: f.installation,
      }),
    ).toBe('selected-prepared')
    expect(f.calls).toEqual(['generation', 'prepare', 'release'])
    expect(storage.calls).toEqual([])
  })

  test('copy recovery waits for configuration activation before reading live config and preparing', async () => {
    const f = fixture()
    const storage = new Storage()
    const binding = selected(storage)
    const pending = createDatabaseMigrationManifest({
      operationId: 'dbm_daemon_boot_fixture',
      idempotencyKey: 'daemon-boot-fixture',
      sourceGenerationId: 'dbg_daemon_boot_fixture',
      sourceSchemaDigest: history.root.contract.digest,
      sourceDatabaseFingerprint: 'selected-source',
      target,
      ownerId: 'dbo_daemon_boot_fixture',
      ownerLeaseExpiresAt: 1,
      tableCounts: { source: 0, active: 0, archiveOnly: 0 },
      now: 1,
    })
    const status: DatabaseMigrationStatusView = {
      operationId: pending.payload.operationId,
      revision: pending.payload.revision,
      phase: pending.payload.phase,
      sourceGenerationId: pending.payload.source.generationId,
      targetProvider: 'postgresql',
      targetUrlEnv: target.urlEnv,
      target,
      targetDatabaseFingerprint: null,
      tableCounts: pending.payload.tableCounts,
      progress: pending.payload.progress,
      failure: null,
      cancelEligible: true,
      resumeEligible: false,
      rollback: databaseRollbackEligibility(pending),
      firstLiveWriteAt: null,
      rolledBackAt: null,
      rollbackReceiptDigest: null,
      createdAt: 1,
      updatedAt: 1,
    }
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    storage.beforeWrite = async () => {
      entered.resolve()
      await release.promise
    }
    f.installation.listMigrations = async () => [status]
    f.installation.readMigration = async () => pending
    f.installation.resumeMigration = async () => {
      f.calls.push('resume')
      await binding.databaseConfiguration.write(target)
      f.setCandidate({
        kind: 'current',
        generation: {
          source: 'verified-pointer',
          payload: {
            version: 1,
            generationId: 'dbg_daemon_target_fixture',
            provider: 'postgresql',
            operationId: pending.payload.operationId,
            schemaDigest: history.head.contract.digest,
            manifestDigest: pending.digest,
            activatedAt: 2,
          },
        },
      })
      return { ...status, phase: 'accepting-writes', failure: null }
    }
    const original = f.installation.prepareProvider
    f.installation.prepareProvider = async (input) => {
      expect(input.config).toEqual(target)
      expect(storage.calls).toContain('write-ack')
      return await original(input)
    }
    const preparing = prepareDaemonDatabaseProviderForBoot({
      file: f.file,
      configuration: binding.databaseConfiguration,
      installation: f.installation,
    })
    try {
      await entered.promise
      expect(f.calls).toEqual(['generation', 'lock', 'resume'])
      expect(storage.calls).toEqual(['write-enter'])
      release.resolve()
      expect(await preparing).toBe('selected-prepared')
      expect(f.calls).toEqual(['generation', 'lock', 'resume', 'generation', 'prepare', 'release'])
      expect(storage.calls).toEqual(['write-enter', 'preview', 'write-ack', 'load'])
    } finally {
      release.resolve()
      await preparing
    }
  })

  test('selected installation failures keep the original exception and await release', async () => {
    const f = fixture()
    const failure = new Error('selected provider preparation failed')
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    f.installation.prepareProvider = async () => {
      throw failure
    }
    f.installation.releaseUpgradeLock = async () => {
      entered.resolve()
      await release.promise
      f.calls.push('release')
    }
    let settled = false
    const running = prepareDaemonDatabaseProviderForBoot({
      file: f.file,
      configuration: selected(new Storage()).databaseConfiguration,
      installation: f.installation,
    }).then(
      () => 'unexpected success',
      (error: unknown) => {
        settled = true
        return error
      },
    )
    try {
      await entered.promise
      expect(settled).toBe(false)
      release.resolve()
      expect(await running).toBe(failure)
      expect(f.calls.at(-1)).toBe('release')
    } finally {
      release.resolve()
      await running
    }
  })

  test('the file binding retains file database activation with a legacy query-only override', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rfc370-daemon-config-'))
    const configPath = join(home, 'config.json')
    writeFileSync(configPath, JSON.stringify({ ...DEFAULT_CONFIG, maxConcurrentNodes: 5 }))
    const queries = { read: () => ({ ...structuredClone(DEFAULT_CONFIG), database: target }) }
    try {
      const binding = composeApplicationConfigurationBinding({ kind: 'file', configPath, queries })
      expect(binding.queries).toBe(queries)
      expect(await binding.databaseConfiguration.read()).toEqual(DEFAULT_CONFIG.database)
      await binding.databaseConfiguration.write(target)
      expect(await binding.databaseConfiguration.read()).toEqual(target)
      expect((await binding.queries.read()).database).toBe(target)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
