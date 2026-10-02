// Queued admission must await the selected reader and settle before provider
// close. These controls do not start an Intent turn, daemon, or local process.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createIntentPersistence } from '@/modules/intent/composition/persistence'
import { composeIntentQueuedResumption } from '@/modules/intent/composition/queuedResumption'
import { describeEachProvider } from './helpers/eachProvider'

function deferred<T>() {
  let accept!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolve, fail) => {
    accept = resolve
    reject = fail
  })
  return { promise, accept, reject }
}

const config = (rounds: number): Config => ({
  ...structuredClone(DEFAULT_CONFIG),
  intentBuilderMaxGenerateRounds: rounds,
})

describe('RFC-370 queued Intent admission lifetime', () => {
  test('frozen notifications dedupe without effects and start waits for the selected ACK', async () => {
    const entered = deferred<void>()
    const read = deferred<Config>()
    const admitted = deferred<void>()
    const selected = {
      read() {
        expect<unknown>(this).toBe(selected)
        entered.accept()
        return read.promise
      },
    }
    const ids: string[] = ['first', 'first']
    const admissions: { ids: readonly string[]; config: Config }[] = []
    const bindings = composeIntentQueuedResumption({
      configuration: selected,
      async resume(sessionIds, snapshot) {
        admissions.push({ ids: sessionIds, config: snapshot })
        admitted.accept()
      },
      onError(error) {
        throw error
      },
    })
    bindings.enqueue(ids)
    ids.push('mutated-after-enqueue')
    bindings.enqueue(['second', 'first'])
    expect(admissions).toEqual([])
    const handle = bindings.runtimeFactory.start()
    try {
      await entered.promise
      expect(admissions).toEqual([])
      const snapshot = config(17)
      read.accept(snapshot)
      await admitted.promise
      expect(admissions).toEqual([{ ids: ['first', 'second'], config: snapshot }])
      expect(admissions[0]!.config).toBe(snapshot)
      expect(Object.isFrozen(admissions[0]!.ids)).toBe(true)
    } finally {
      read.accept(config(17))
      handle.stop()
      await handle.drain()
    }
  })

  test('stop fences a held read and retains unread IDs for the same composition rollback', async () => {
    const entered = deferred<void>()
    const read = deferred<Config>()
    const resumed = deferred<void>()
    const seen: { ids: readonly string[]; rounds: number | undefined }[] = []
    let reads = 0
    const bindings = composeIntentQueuedResumption({
      configuration: {
        read() {
          reads += 1
          if (reads === 1) {
            entered.accept()
            return read.promise
          }
          return config(29)
        },
      },
      async resume(ids, snapshot) {
        seen.push({ ids, rounds: snapshot.intentBuilderMaxGenerateRounds })
        resumed.accept()
      },
      onError(error) {
        throw error
      },
    })
    const first = bindings.runtimeFactory.start()
    bindings.enqueue(['old', 'old'])
    await entered.promise
    first.stop()
    first.stop()
    bindings.enqueue(['new'])
    let drained = false
    const completion = first.drain().then(() => {
      drained = true
    })
    try {
      expect(drained).toBe(false)
      expect(seen).toEqual([])
      expect(() => bindings.runtimeFactory.start()).toThrow('already-started')
      read.accept(config(11))
      await completion
      expect(seen).toEqual([])
      const second = bindings.runtimeFactory.start()
      try {
        await resumed.promise
        expect(seen).toEqual([{ ids: ['old', 'new'], rounds: 29 }])
        expect(reads).toBe(2)
      } finally {
        second.stop()
        await second.drain()
      }
    } finally {
      read.accept(config(11))
      await completion
    }
  })

  test('drain waits for already admitted work and frozen requests use the next live value', async () => {
    const entered = deferred<void>()
    const admissionAck = deferred<void>()
    const next = deferred<void>()
    const seen: { ids: readonly string[]; rounds: number | undefined }[] = []
    let snapshot = config(3)
    const bindings = composeIntentQueuedResumption({
      configuration: { read: () => snapshot },
      async resume(ids, selected) {
        seen.push({ ids, rounds: selected.intentBuilderMaxGenerateRounds })
        if (seen.length === 1) {
          entered.accept()
          await admissionAck.promise
        } else next.accept()
      },
      onError(error) {
        throw error
      },
    })
    const first = bindings.runtimeFactory.start()
    bindings.enqueue(['admitted'])
    await entered.promise
    first.stop()
    snapshot = config(9)
    bindings.enqueue(['next'])
    let settled = false
    const draining = first.drain().then(() => {
      settled = true
    })
    try {
      expect(settled).toBe(false)
      expect(seen).toEqual([{ ids: ['admitted'], rounds: 3 }])
      admissionAck.accept()
      await draining
      const second = bindings.runtimeFactory.start()
      try {
        await next.promise
        expect(seen).toEqual([
          { ids: ['admitted'], rounds: 3 },
          { ids: ['next'], rounds: 9 },
        ])
      } finally {
        second.stop()
        await second.drain()
      }
    } finally {
      admissionAck.accept()
      await draining
    }
  })

  test.each([null, undefined, 'reader-failed', new Error('reader-failed')])(
    'read rejection %p is reported once and cannot dispatch',
    async (failure) => {
      const reported = deferred<void>()
      const errors: unknown[] = []
      let admissions = 0
      const bindings = composeIntentQueuedResumption({
        configuration: { read: () => Promise.reject(failure) },
        async resume() {
          admissions += 1
        },
        onError(error) {
          errors.push(error)
          reported.accept()
        },
      })
      const handle = bindings.runtimeFactory.start()
      try {
        bindings.enqueue(['pending'])
        await reported.promise
      } finally {
        handle.stop()
        await handle.drain()
      }
      expect(errors).toEqual([failure])
      expect(admissions).toBe(0)
    },
  )

  test('drain observes admission rejection and asynchronous error reporting', async () => {
    const entered = deferred<void>()
    const reportAck = deferred<void>()
    const failure = new Error('admission-failed')
    const errors: unknown[] = []
    const bindings = composeIntentQueuedResumption({
      configuration: { read: () => config(1) },
      async resume() {
        throw failure
      },
      async onError(error) {
        errors.push(error)
        entered.accept()
        await reportAck.promise
      },
    })
    const handle = bindings.runtimeFactory.start()
    bindings.enqueue(['pending'])
    await entered.promise
    handle.stop()
    let settled = false
    const completion = handle.drain().then(() => {
      settled = true
    })
    try {
      expect(settled).toBe(false)
      expect(errors).toEqual([failure])
    } finally {
      reportAck.accept()
      await completion
    }
  })

  test('reporter failure reaches drain instead of escaping a notification callback', async () => {
    const entered = deferred<void>()
    const failure = new Error('reporter-failed')
    const bindings = composeIntentQueuedResumption({
      configuration: { read: () => Promise.reject('read-failed') },
      async resume() {
        throw new Error('must not admit')
      },
      onError() {
        entered.accept()
        throw failure
      },
    })
    const handle = bindings.runtimeFactory.start()
    expect(() => bindings.enqueue(['pending'])).not.toThrow()
    await entered.promise
    handle.stop()
    try {
      await handle.drain()
      throw new Error('missing reporting failure')
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      if (!(error instanceof AggregateError)) throw error
      expect(error.errors).toEqual([failure])
    }
  })

  test('empty notifications do not read; each handle must stop before drain', async () => {
    let reads = 0
    const bindings = composeIntentQueuedResumption({
      configuration: {
        read() {
          reads += 1
          return config(1)
        },
      },
      async resume() {},
      onError(error) {
        throw error
      },
    })
    bindings.enqueue([])
    const handle = bindings.runtimeFactory.start()
    bindings.enqueue([])
    await expect(handle.drain()).rejects.toThrow('drain-before-stop')
    handle.stop()
    await handle.drain()
    expect(reads).toBe(0)
  })
})

describeEachProvider('RFC-370 queued admission selected database', (harness) => {
  test('each live notification uses its current selected snapshot with the same provider', async () => {
    const persistence = createIntentPersistence(harness.db)
    const first = deferred<void>()
    const second = deferred<void>()
    const recording = harness.recordStatements()
    const seen: number[] = []
    let current = config(7)
    const bindings = composeIntentQueuedResumption({
      configuration: { read: () => current },
      async resume(ids, snapshot) {
        for (const id of ids) expect(await persistence.findSession(id)).toBeNull()
        seen.push(snapshot.intentBuilderMaxGenerateRounds ?? 50)
        if (seen.length === 1) first.accept()
        else second.accept()
      },
      onError(error) {
        throw error
      },
    })
    const handle = bindings.runtimeFactory.start()
    try {
      bindings.enqueue(['first-missing-session'])
      await first.promise
      current = config(41)
      bindings.enqueue(['second-missing-session'])
      await second.promise
      handle.stop()
      await handle.drain()
      expect(seen).toEqual([7, 41])
      expect(
        recording.statements.filter((item) => item.sql.includes('intent_sessions')),
      ).toHaveLength(2)
    } finally {
      handle.stop()
      await handle.drain()
      recording.stop()
    }
  })

  test('selected ACK precedes all provider queries; a stopped read cannot touch the DB', async () => {
    const persistence = createIntentPersistence(harness.db)
    const entered = deferred<void>()
    const read = deferred<Config>()
    const recording = harness.recordStatements()
    let admissions = 0
    const bindings = composeIntentQueuedResumption({
      configuration: {
        read() {
          entered.accept()
          return read.promise
        },
      },
      async resume(ids) {
        admissions += 1
        for (const id of ids) await persistence.findSession(id)
      },
      onError(error) {
        throw error
      },
    })
    const handle = bindings.runtimeFactory.start()
    try {
      bindings.enqueue(['not-found'])
      await entered.promise
      expect(recording.statements).toEqual([])
      handle.stop()
      read.accept(config(1))
      await handle.drain()
      expect(admissions).toBe(0)
      expect(recording.statements).toEqual([])
    } finally {
      read.accept(config(1))
      handle.stop()
      await handle.drain()
      recording.stop()
    }
  })

  test('read failure performs zero provider work without a local fallback', async () => {
    const persistence = createIntentPersistence(harness.db)
    const reported = deferred<void>()
    const failure = new Error('selected-source-failed')
    const recording = harness.recordStatements()
    const errors: unknown[] = []
    const bindings = composeIntentQueuedResumption({
      configuration: { read: () => Promise.reject(failure) },
      async resume(ids) {
        for (const id of ids) await persistence.findSession(id)
      },
      onError(error) {
        errors.push(error)
        reported.accept()
      },
    })
    const handle = bindings.runtimeFactory.start()
    try {
      bindings.enqueue(['not-found'])
      await reported.promise
      handle.stop()
      await handle.drain()
      expect(errors).toEqual([failure])
      expect(recording.statements).toEqual([])
    } finally {
      handle.stop()
      await handle.drain()
      recording.stop()
    }
  })
})

test('both actual provider roots compose one selected queued lifetime before maintenance', () => {
  const file = ts.createSourceFile(
    'start.ts',
    readFileSync(resolve(import.meta.dir, '../src/cli/start.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const compact = (node: ts.Node): string => node.getText(file).replace(/\s/g, '')
  for (const [name, query, firstRuntime] of [
    ['composePostgresqlProviderSession', 'configuration:input.configuration', 'runtimeFactories'],
    ['composeSqliteProviderSession', 'configuration,', 'providerRuntimeFactories'],
  ] as const) {
    const root = file.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name,
    )
    if (root?.body === undefined) throw new Error(`missing ${name}`)
    const nodes: ts.Node[] = []
    const visit = (node: ts.Node): void => {
      nodes.push(node)
      ts.forEachChild(node, visit)
    }
    visit(root.body)
    const selected = nodes.filter(
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && compact(node.expression) === 'composeIntentQueuedResumption',
    )
    expect(selected).toHaveLength(1)
    expect(compact(selected[0]!.arguments[0]!)).toContain(query)
    expect(compact(selected[0]!)).not.toContain('loadConfig(')
    const maintenance = nodes.filter(
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && compact(node.expression) === 'startMaintenanceService',
    )
    expect(maintenance).toHaveLength(1)
    expect(selected[0]!.pos).toBeLessThan(maintenance[0]!.pos)
    expect(compact(maintenance[0]!)).toContain('intentQueuedResumption.enqueue')
    const factories = nodes.filter(
      (node) =>
        (ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) &&
        node.name.getText(file) === firstRuntime,
    )
    expect(factories).toHaveLength(1)
    expect(compact(factories[0]!)).toContain('[intentQueuedResumption.runtimeFactory,')
    expect(compact(root.body)).not.toContain('pendingIntentSessionIds')
    expect(compact(root.body)).not.toContain('loadConfig(Paths.config)')
  }
})
