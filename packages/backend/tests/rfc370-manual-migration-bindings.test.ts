// RFC-370: the actual manual CLI entry chooses the existing selected
// installation ports, waits for their ACKs and closes the prepared lifetime.
// Effects are explicit fakes; existing cli/RFC-359 suites retain real file/DB
// migration coverage. No daemon, worker or provider connection is started here.
import { describe, expect, test } from 'bun:test'
import { DatabaseConfigSchema } from '@agent-workflow/shared'
import { migrateCommand } from '@/cli/migrate'
import type { DatabaseConfigurationPort } from '@/modules/system-operations/application/ports/databaseConfiguration'
import type { DatabaseInstallationPort } from '@/modules/system-operations/application/ports/databaseInstallation'
import type { PreparedManualDatabaseMigration } from '@/modules/system-operations/composition/manualDatabaseMigration'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import {
  DatabaseGenerationPayloadSchema,
  digestDatabaseArtifact,
  type DatabaseGenerationBootstrapCandidate,
} from '@/platform/persistence/generationValidation'
import {
  advanceDatabaseMigration,
  createDatabaseMigrationManifest,
  DATABASE_MIGRATION_PHASES,
  serializeDatabaseMigrationManifest,
  type DatabaseMigrationManifest,
} from '@/modules/system-operations/domain/databaseMigration'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
function held() {
  return { entered: barrier(), release: barrier() }
}

function fixture(provider: DatabaseProvider) {
  const calls: string[] = []
  const read = held(),
    prepare = held(),
    release = held(),
    close = held()
  let readFailure: Error | null = null
  let descriptionFailure: Error | null = null
  let closeFailure: Error | null = null
  const current = DatabaseConfigSchema.parse({ provider })
  let migration: DatabaseMigrationManifest | null = null
  let preparedContract: LogicalSchemaContract | null = null
  const configuration: DatabaseConfigurationPort = {
    async read() {
      expect<unknown>(this).toBe(configuration)
      calls.push('read-config')
      read.entered.resolve()
      await read.release.promise
      if (readFailure !== null) throw readFailure
      return structuredClone(current)
    },
    async write() {
      throw new Error('current-generation preparation must not activate new config')
    },
  }
  async function closePrepared(this: PreparedManualDatabaseMigration['runtime']) {
    expect<unknown>(this).toBe(runtime)
    calls.push('close-start')
    close.entered.resolve()
    await close.release.promise
    if (closeFailure !== null) throw closeFailure
    calls.push('closed')
  }
  const runtime: PreparedManualDatabaseMigration['runtime'] =
    provider === 'sqlite'
      ? { provider: 'sqlite', close: closePrepared }
      : { provider: 'postgresql', close: closePrepared }
  const prepared: PreparedManualDatabaseMigration = {
    runtime,
    describeSchemaOutcome() {
      expect<unknown>(this).toBe(prepared)
      calls.push('describe')
      if (descriptionFailure !== null) throw descriptionFailure
      return `${provider}: selected schema ready`
    },
  }
  const installation: DatabaseInstallationPort<PreparedManualDatabaseMigration> = {
    async readGeneration({ contract }): Promise<DatabaseGenerationBootstrapCandidate> {
      expect<unknown>(this).toBe(installation)
      calls.push('read-generation')
      preparedContract = contract
      if (current.provider === 'postgresql') {
        migration = createDatabaseMigrationManifest({
          operationId: 'dbm_manual_selected_fixture',
          idempotencyKey: 'manual-selected-start',
          sourceGenerationId: 'dbg_manual_selected_source',
          sourceSchemaDigest: contract.digest,
          sourceDatabaseFingerprint: 'sqlite:manual-selected-source',
          target: current,
          tableCounts: {
            source: contract.sourceTableCount,
            active: contract.activeTableCount,
            archiveOnly: contract.archiveOnlyTableCount,
          },
          ownerId: 'dbo_manual_selected_fixture',
          ownerLeaseExpiresAt: 30_000,
          now: 1,
        })
        // Produce a current PG receipt through the actual pure phase machine,
        // including its finalized receipt and matching manifest artifact.
        for (const nextPhase of DATABASE_MIGRATION_PHASES.slice(1)) {
          migration = advanceDatabaseMigration(migration, {
            expectedRevision: migration.payload.revision,
            expectedPhase: migration.payload.phase,
            nextPhase,
            ownerId: migration.payload.owner.id,
            ownerFence: migration.payload.owner.fence,
            idempotencyKey: `manual-selected-${nextPhase}`,
            now: migration.payload.updatedAt + 1,
            ...(nextPhase === 'preflighted'
              ? { targetDatabaseFingerprint: 'postgresql:manual-selected-target' }
              : {}),
            ...(nextPhase === 'backed-up' ? { sourceBackupDigest: contract.digest } : {}),
            ...(nextPhase === 'verifying'
              ? { logicalBackupDigest: contract.digest, legacyArchiveDigest: contract.digest }
              : {}),
            ...(nextPhase === 'cutover-prepared' ? { verificationDigest: contract.digest } : {}),
            ...(nextPhase === 'finalized' ? { receiptDigest: contract.digest } : {}),
          })
        }
      }
      return {
        kind: 'current',
        generation: {
          source: 'verified-pointer',
          payload: DatabaseGenerationPayloadSchema.parse({
            version: 1,
            generationId: 'dbg_manual_selected_fixture',
            provider,
            operationId: migration?.payload.operationId ?? null,
            schemaDigest: contract.digest,
            manifestDigest:
              migration === null
                ? null
                : digestDatabaseArtifact(serializeDatabaseMigrationManifest(migration) + '\n'),
            activatedAt: migration?.payload.updatedAt ?? 1,
          }),
        },
      }
    },
    async listMigrations() {
      expect<unknown>(this).toBe(installation)
      calls.push('list-migrations')
      return []
    },
    async resolveRecoverySource(input) {
      expect<unknown>(this).toBe(installation)
      if (migration === null || preparedContract === null) {
        throw new Error('no recovery source expected for SQLite')
      }
      expect(input.fromContractDigest).toBe(migration.payload.source.schemaDigest)
      expect(input.toContractDigest).toBe(preparedContract.digest)
      calls.push('resolve-source')
      return preparedContract
    },
    async readMigration(operationId) {
      expect<unknown>(this).toBe(installation)
      if (migration === null) throw new Error('no migration expected for SQLite')
      expect(operationId).toBe(migration.payload.operationId)
      expect(migration.payload.phase).toBe('finalized')
      calls.push('read-migration')
      return migration
    },
    async writeGeneration() {
      throw new Error('current generation must not be rewritten')
    },
    async requireUpgradeLock() {
      throw new Error('current generation needs no upgrade lock')
    },
    async resumeMigration() {
      throw new Error('no recovery expected')
    },
    async releaseUpgradeLock() {
      expect<unknown>(this).toBe(installation)
      calls.push('release-start')
      release.entered.resolve()
      await release.release.promise
      calls.push('released')
    },
    async prepareProvider(input) {
      expect<unknown>(this).toBe(installation)
      expect(input.config).toEqual(current)
      expect(input.candidate.kind).toBe('current')
      calls.push('prepare-start')
      prepare.entered.resolve()
      await prepare.release.promise
      await input.advancePointer()
      calls.push('prepared')
      return prepared
    },
  }
  return {
    calls,
    read,
    prepare,
    release,
    close,
    run: () => migrateCommand({ kind: 'selected', configuration, installation }),
    failRead: (error: Error) => {
      readFailure = error
    },
    failDescription: (error: Error) => {
      descriptionFailure = error
    },
    failClose: (error: Error) => {
      closeFailure = error
    },
    releaseAll() {
      read.release.resolve()
      prepare.release.resolve()
      release.release.resolve()
      close.release.resolve()
    },
  }
}

describe.each(['sqlite', 'postgresql'] as const)(
  'RFC-370 manual migration selected %s lifetime',
  (provider) => {
    test('awaits config, preparation, release and close through the actual CLI', async () => {
      const f = fixture(provider)
      let settled = false
      const pending = f.run().then((result) => {
        settled = true
        return result
      })
      const reach = async (entered: Promise<void>, label: string) => {
        await Promise.race([
          entered,
          pending.then(() => {
            throw new Error(`manual migration returned before ${label}`)
          }),
        ])
        expect(settled).toBe(false)
      }
      try {
        await reach(f.read.entered.promise, 'configuration')
        expect(f.calls).toEqual(['read-config'])
        f.read.release.resolve()
        await reach(f.prepare.entered.promise, 'preparation')
        expect(f.calls).toEqual([
          'read-config',
          'read-generation',
          'list-migrations',
          ...(provider === 'postgresql' ? ['read-migration', 'resolve-source'] : []),
          'prepare-start',
        ])
        f.prepare.release.resolve()
        await reach(f.release.entered.promise, 'installation release')
        expect(f.calls).not.toContain('describe')
        expect(f.calls).not.toContain('close-start')
        f.release.release.resolve()
        await reach(f.close.entered.promise, 'provider close')
        expect(f.calls).toEqual([
          'read-config',
          'read-generation',
          'list-migrations',
          ...(provider === 'postgresql' ? ['read-migration', 'resolve-source'] : []),
          'prepare-start',
          'prepared',
          'release-start',
          'released',
          'describe',
          'close-start',
        ])
        f.close.release.resolve()
        expect(await pending).toEqual({ output: `${provider}: selected schema ready` })
        expect(f.calls.at(-1)).toBe('closed')
      } finally {
        f.releaseAll()
        await pending
      }
    })

    test('selected initial read failure never reaches installation or a file fallback', async () => {
      const f = fixture(provider)
      const failure = new Error('selected manual configuration unavailable')
      f.failRead(failure)
      f.releaseAll()
      await expect(f.run()).rejects.toBe(failure)
      expect(f.calls).toEqual(['read-config'])
    })

    test('a description failure still waits for close and preserves that failure', async () => {
      const f = fixture(provider)
      const failure = new Error('selected schema description unavailable')
      f.failDescription(failure)
      f.read.release.resolve()
      f.prepare.release.resolve()
      f.release.release.resolve()
      const pending = f.run()
      try {
        await Promise.race([
          f.close.entered.promise,
          pending.then(() => {
            throw new Error('description failure skipped close')
          }),
        ])
        expect(f.calls.at(-1)).toBe('close-start')
        f.close.release.resolve()
        await expect(pending).rejects.toBe(failure)
        expect(f.calls.at(-1)).toBe('closed')
      } finally {
        f.releaseAll()
        await pending.catch(() => undefined)
      }
    })

    test('a close failure retains the existing finally precedence over description failure', async () => {
      const f = fixture(provider)
      const closeFailure = new Error('selected provider close failed')
      f.failDescription(new Error('description failed first'))
      f.failClose(closeFailure)
      f.releaseAll()
      await expect(f.run()).rejects.toBe(closeFailure)
      expect(f.calls.slice(-3)).toEqual(['released', 'describe', 'close-start'])
      expect(f.calls).not.toContain('closed')
    })
  },
)
