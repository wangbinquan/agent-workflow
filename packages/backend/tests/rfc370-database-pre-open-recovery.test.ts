// Pre-open generation reads and restore completion stay in their original phases.
import { describe, expect, test } from 'bun:test'
import type { DatabaseProvider } from '@agent-workflow/shared'
import type { DatabasePreOpenRecoveryPort } from '@/modules/system-operations/application/ports/databasePreOpenRecovery'
import { prepareDatabasePreOpenRecovery } from '@/modules/system-operations/composition'
import type {
  DatabaseGenerationBootstrapCandidate,
  DatabaseGenerationPayload,
} from '@/platform/persistence/generationValidation'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'

const history = await loadPostgresqlMigrationHistory()
const contract = history.head.contract

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function generation(
  provider: DatabaseProvider = 'sqlite',
  kind: DatabaseGenerationBootstrapCandidate['kind'] = 'current',
): DatabaseGenerationBootstrapCandidate {
  const payload: DatabaseGenerationPayload = {
    version: 1,
    generationId: 'dbg_pre_open_fixture',
    provider,
    operationId: kind === 'operation-recovery' ? 'dbm_pre_open_fixture' : null,
    schemaDigest: kind === 'schema-upgrade' ? history.root.contract.digest : contract.digest,
    manifestDigest: kind === 'operation-recovery' ? 'manifest-digest' : null,
    activatedAt: 1,
  }
  if (kind === 'current') {
    return { kind, generation: { source: 'verified-pointer', payload } }
  }
  if (kind === 'schema-upgrade') return { kind, payload, pointerDigest: 'pointer-digest' }
  return {
    kind,
    payload,
    pointerDigest: 'pointer-digest',
    recoveryManifestDigest: 'manifest-digest',
  }
}

class SelectedRecovery implements DatabasePreOpenRecoveryPort<typeof history> {
  readonly calls: string[] = []
  candidate = generation()
  restored = true
  beforeHistory?: () => void | Promise<void>
  beforeGeneration?: () => void | Promise<void>
  beforeRestore?: () => void | Promise<void>

  async readMigrationHistory() {
    this.calls.push('history')
    await this.beforeHistory?.()
    return history
  }

  async readGeneration(
    input: Parameters<DatabasePreOpenRecoveryPort<typeof history>['readGeneration']>[0],
  ) {
    this.calls.push('generation')
    expect(input.contract).toBe(contract)
    expect(input.history).toBe(history)
    await this.beforeGeneration?.()
    return this.candidate
  }

  async applyStagedRestore() {
    this.calls.push('restore')
    await this.beforeRestore?.()
    return this.restored
  }
}

function prepare(recovery: DatabasePreOpenRecoveryPort<typeof history>) {
  return prepareDatabasePreOpenRecovery({
    contract,
    recovery,
    get migrationsFolder(): string {
      throw new Error('selected recovery must not construct a local fallback')
    },
  })
}

async function enteredBeforeCompletion<T>(entered: Promise<void>, operation: Promise<T>) {
  const first = await Promise.race([
    entered.then(() => 'entered'),
    operation.then(
      () => 'completed',
      () => 'rejected',
    ),
  ])
  expect(first).toBe('entered')
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('RFC-370 selected database pre-open recovery', () => {
  test('history, generation and restore each wait for their selected completion', async () => {
    const recovery = new SelectedRecovery()
    const historyEntered = deferred()
    const generationEntered = deferred()
    const restoreEntered = deferred()
    const allowHistory = deferred()
    const allowGeneration = deferred()
    const allowRestore = deferred()
    recovery.beforeHistory = async () => {
      historyEntered.resolve()
      await allowHistory.promise
    }
    recovery.beforeGeneration = async () => {
      generationEntered.resolve()
      await allowGeneration.promise
    }
    recovery.beforeRestore = async () => {
      restoreEntered.resolve()
      await allowRestore.promise
    }
    let prepared = false
    let restored = false
    const preparing = prepare(recovery).then((value) => {
      prepared = true
      return value
    })
    let restoring: Promise<boolean> | undefined
    try {
      await enteredBeforeCompletion(historyEntered.promise, preparing)
      expect(prepared).toBe(false)
      expect(recovery.calls).toEqual(['history'])
      allowHistory.resolve()
      await enteredBeforeCompletion(generationEntered.promise, preparing)
      expect(prepared).toBe(false)
      expect(recovery.calls).toEqual(['history', 'generation'])
      allowGeneration.resolve()
      const ready = await preparing
      expect(ready.history).toBe(history)
      expect(recovery.calls).toEqual(['history', 'generation'])
      restoring = ready.applyStagedRestore().then((value) => {
        restored = true
        return value
      })
      await enteredBeforeCompletion(restoreEntered.promise, restoring)
      expect(restored).toBe(false)
      expect(recovery.calls).toEqual(['history', 'generation', 'restore'])
      allowRestore.resolve()
      expect(await restoring).toBe(true)
    } finally {
      allowHistory.resolve()
      allowGeneration.resolve()
      allowRestore.resolve()
      await preparing
      if (restoring) await restoring
    }
  })

  for (const provider of ['sqlite', 'postgresql'] as const) {
    for (const kind of ['current', 'schema-upgrade', 'operation-recovery'] as const) {
      test(`${provider} ${kind} retains the original pre-open decision`, async () => {
        const recovery = new SelectedRecovery()
        recovery.candidate = generation(provider, kind)
        const ready = await prepare(recovery)
        expect(recovery.calls).toEqual(['history', 'generation'])
        expect(await ready.applyStagedRestore()).toBe(provider === 'sqlite')
        expect(recovery.calls).toEqual(
          provider === 'sqlite' ? ['history', 'generation', 'restore'] : ['history', 'generation'],
        )
      })
    }
  }

  test('a synchronous selected port retains member receivers and a false restore result', async () => {
    const calls: string[] = []
    const recovery: DatabasePreOpenRecoveryPort<typeof history> = {
      readMigrationHistory() {
        expect(this).toBe(recovery)
        calls.push('history')
        return history
      },
      readGeneration(input) {
        expect(this).toBe(recovery)
        expect(input.contract).toBe(contract)
        expect(input.history).toBe(history)
        calls.push('generation')
        return generation()
      },
      applyStagedRestore() {
        expect(this).toBe(recovery)
        calls.push('restore')
        return false
      },
    }
    const ready = await prepare(recovery)
    expect(ready.history).toBe(history)
    expect(await ready.applyStagedRestore()).toBe(false)
    expect(calls).toEqual(['history', 'generation', 'restore'])
  })

  test('selected history remains an opaque host value at the application boundary', async () => {
    const metadata = { reference: 'artifact://database-history/revision-7' } as const
    const recovery: DatabasePreOpenRecoveryPort<typeof metadata> = {
      readMigrationHistory() {
        return metadata
      },
      readGeneration(input) {
        expect(input.history).toBe(metadata)
        expect(input.contract).toBe(contract)
        return generation()
      },
      applyStagedRestore() {
        return true
      },
    }
    const ready = await prepareDatabasePreOpenRecovery({
      contract,
      recovery,
      get migrationsFolder(): string {
        throw new Error('opaque selected history must not enter the file adapter')
      },
    })
    expect(ready.history).toBe(metadata)
    expect(await ready.applyStagedRestore()).toBe(true)
  })

  for (const phase of ['history', 'generation'] as const) {
    test(`${phase} rejection stays in preparation before restore is attempted`, async () => {
      const recovery = new SelectedRecovery()
      const failure = new Error(`${phase} failure`)
      const reject = () => {
        throw failure
      }
      if (phase === 'history') recovery.beforeHistory = reject
      else recovery.beforeGeneration = reject
      await expect(prepare(recovery)).rejects.toBe(failure)
      expect(recovery.calls).toEqual(phase === 'history' ? ['history'] : ['history', 'generation'])
    })
  }

  test('restore rejection keeps the original error in the later restore phase', async () => {
    const recovery = new SelectedRecovery()
    const failure = new Error('restore failure')
    recovery.beforeRestore = () => {
      throw failure
    }
    const ready = await prepare(recovery)
    expect(recovery.calls).toEqual(['history', 'generation'])
    await expect(ready.applyStagedRestore()).rejects.toBe(failure)
    expect(recovery.calls).toEqual(['history', 'generation', 'restore'])
  })
})
