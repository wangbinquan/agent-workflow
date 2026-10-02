// RFC-370: installation orchestration must await host metadata and lock effects.
// Existing RFC-359 generation/PG-upgrade suites exercise the real file adapter,
// historical databases and interrupted copy recovery through the same application.
import { describe, expect, test } from 'bun:test'
import { prepareDatabaseInstallation } from '@/modules/system-operations/application/prepareDatabaseInstallation'
import type { DatabaseInstallationPort } from '@/modules/system-operations/application/ports/databaseInstallation'
import { prepareDatabaseProviderForBoot } from '@/modules/system-operations/composition'
import {
  digestGenerationPayload,
  type DatabaseGenerationBootstrapCandidate,
  type DatabaseGenerationPayload,
} from '@/platform/persistence/generationValidation'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'

const history = await loadPostgresqlMigrationHistory()

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(current = false, entry: 'application' | 'boot-composition' = 'application') {
  const calls: string[] = []
  const payload: DatabaseGenerationPayload = {
    version: 1,
    generationId: 'dbg_installation_fixture',
    provider: 'sqlite',
    operationId: null,
    schemaDigest: current ? history.head.contract.digest : history.root.contract.digest,
    manifestDigest: null,
    activatedAt: 1,
  }
  let candidate: DatabaseGenerationBootstrapCandidate = current
    ? { kind: 'current', generation: { source: 'verified-pointer', payload } }
    : { kind: 'schema-upgrade', payload, pointerDigest: digestGenerationPayload(payload) }
  const effects: DatabaseInstallationPort<string> = {
    async readGeneration() {
      calls.push('read')
      return candidate
    },
    async resolveRecoverySource() {
      throw new Error('no recovery expected')
    },
    async listMigrations() {
      return []
    },
    async readMigration() {
      throw new Error('no migration expected')
    },
    async writeGeneration(next) {
      calls.push('write')
      candidate = { kind: 'current', generation: { source: 'verified-pointer', payload: next } }
    },
    async requireUpgradeLock() {
      calls.push('lock')
    },
    async releaseUpgradeLock() {
      calls.push('release')
    },
    async resumeMigration() {
      throw new Error('no recovery expected')
    },
    async prepareProvider(input) {
      calls.push('prepare')
      await input.advancePointer()
      calls.push('admit')
      return 'prepared'
    },
  }
  const run = () => {
    const input = {
      config: { provider: 'sqlite' },
      contract: history.head.contract,
      configuration: {
        read: () => {
          throw new Error('no copy recovery: retain initial config')
        },
        write: () => {
          throw new Error('no copy recovery: retain initial config')
        },
      },
    } as const
    return entry === 'boot-composition'
      ? prepareDatabaseProviderForBoot({ ...input, installation: effects })
      : prepareDatabaseInstallation({ ...input, effects })
  }
  return {
    calls,
    effects,
    payload,
    run,
    setCandidate: (next: DatabaseGenerationBootstrapCandidate) => {
      candidate = next
    },
  }
}

describe.each(['application', 'boot-composition'] as const)(
  'RFC-370 installation host effects through %s',
  (entry) => {
    test('a current generation does not rewrite metadata or take an upgrade lock', async () => {
      const f = fixture(true, entry)
      expect(await f.run()).toBe('prepared')
      expect(f.calls).toEqual(['read', 'prepare', 'admit', 'release'])
    })

    test('awaits the lock before preparing and metadata commit before admission and release', async () => {
      const f = fixture(false, entry)
      const locked = deferred()
      const lockEntered = deferred()
      const written = deferred()
      const writeEntered = deferred()
      f.effects.requireUpgradeLock = async () => {
        f.calls.push('lock-start')
        lockEntered.resolve()
        await locked.promise
        f.calls.push('locked')
      }
      const write = f.effects.writeGeneration
      f.effects.writeGeneration = async (payload) => {
        writeEntered.resolve()
        await written.promise
        await write(payload)
      }
      const result = f.run()
      await lockEntered.promise
      expect(f.calls).not.toContain('prepare')
      locked.resolve()
      await writeEntered.promise
      expect(f.calls).not.toContain('admit')
      expect(f.calls).not.toContain('release')
      written.resolve()
      expect(await result).toBe('prepared')
      expect(f.calls).toEqual([
        'read',
        'lock-start',
        'locked',
        'prepare',
        'read',
        'write',
        'admit',
        'release',
      ])
    })

    test.each(['lock', 'prepare', 'write'] as const)(
      '%s failure releases the owned preparation boundary without admission',
      async (stage) => {
        const f = fixture(false, entry)
        const failure = new Error(`${stage} failed`)
        if (stage === 'lock')
          f.effects.requireUpgradeLock = async () => {
            throw failure
          }
        if (stage === 'prepare')
          f.effects.prepareProvider = async () => {
            throw failure
          }
        if (stage === 'write')
          f.effects.writeGeneration = async () => {
            throw failure
          }
        await expect(f.run()).rejects.toBe(failure)
        expect(f.calls.at(-1)).toBe('release')
        expect(f.calls).not.toContain('admit')
      },
    )

    test('a changed generation still rejects the pending write', async () => {
      const f = fixture(false, entry)
      f.effects.prepareProvider = async (input) => {
        const changed = { ...f.payload, generationId: 'dbg_replaced_installation' }
        f.setCandidate({
          kind: 'schema-upgrade',
          payload: changed,
          pointerDigest: digestGenerationPayload(changed),
        })
        await input.advancePointer()
        return 'unexpected admission'
      }
      await expect(f.run()).rejects.toThrow('database generation changed during schema preparation')
      expect(f.calls).not.toContain('write')
      expect(f.calls.at(-1)).toBe('release')
    })

    test('an already advanced pointer is retained without a second write', async () => {
      const f = fixture(false, entry)
      f.effects.prepareProvider = async (input) => {
        f.setCandidate({
          kind: 'current',
          generation: {
            source: 'verified-pointer',
            payload: { ...f.payload, schemaDigest: history.head.contract.digest },
          },
        })
        await input.advancePointer()
        return 'prepared'
      }
      expect(await f.run()).toBe('prepared')
      expect(f.calls).not.toContain('write')
    })
  },
)
