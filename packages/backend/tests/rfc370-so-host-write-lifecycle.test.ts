import { expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hostExecutionWriteContexts, workflows } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createHostExecutionAuthorityLifecycle,
  type CreateHostExecutionAuthorityLifecycleInput,
} from '@/modules/system-operations/application/hostExecutionAuthority'
import {
  composeHostExecutionAuthorityBinding,
  type HostExecutionAuthoritySelection,
} from '@/modules/system-operations/composition/hostExecutionAuthority'
import { composeHostExecutionWriteContext } from '@/modules/system-operations/composition/hostExecutionWriteContext'
import { composeHostExecutionWriteLifecycle } from '@/modules/system-operations/composition/hostExecutionWriteLifecycle'
import type {
  HostExecutionAuthorityDriver,
  HostExecutionAuthorityObservation,
  HostExecutionGrantContext,
  HostExecutionWriteContext,
  HostExecutionWriteLeaseFacts,
  HostExecutionWriteLifecycle,
  HostExecutionWriteReceipt,
} from '@/modules/system-operations/public/participants'
import { createTaskHostWriteContextAdapter } from '@/modules/task-execution/infrastructure/hostExecutionWriteContext'
import { withTaskExecutionWrite } from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import { describeEachProvider } from './helpers/eachProvider'
import { deferred, nextTurn } from './helpers/taskHostExecution'
import originals from './fixtures/rfc370-so-host-write-lifecycle-original-sources.json'

function inverseWriteLifecycle(
  text: string,
  edits: readonly { readonly start: number; readonly introduced: string; readonly prior: string }[],
): string {
  let restored = text
  for (const edit of [...edits].reverse()) {
    if (restored.slice(edit.start, edit.start + edit.introduced.length) !== edit.introduced) {
      throw new Error('SO write lifecycle inverse unreviewed fragment')
    }
    restored =
      restored.slice(0, edit.start) +
      edit.prior +
      restored.slice(edit.start + edit.introduced.length)
  }
  return restored
}

test('W26 finite SO inverse restores every whole original authority source and native oracle', () => {
  expect(originals.files).toHaveLength(5)
  for (const original of originals.files) {
    const text = readFileSync(new URL(`../../../${original.path}`, import.meta.url), 'utf8')
    const restored = inverseWriteLifecycle(text, original.inverseEdits)
    expect(Buffer.byteLength(restored)).toBe(original.bytes)
    expect(createHash('sha256').update(restored).digest('hex')).toBe(original.sha256)
    for (const edit of original.inverseEdits) {
      if (edit.introduced.length === 0) continue
      const changed = text.slice(0, edit.start) + '!' + text.slice(edit.start + 1)
      expect(() => inverseWriteLifecycle(changed, original.inverseEdits)).toThrow(
        'SO write lifecycle inverse unreviewed fragment',
      )
    }
    const suffix = '\n// unrelated source change remains visible\n'
    expect(inverseWriteLifecycle(text + suffix, original.inverseEdits)).toBe(restored + suffix)
  }
})

type WriteStage = 'prepare' | 'activate' | 'renew' | 'drain' | 'retire'
interface FixtureOptions {
  readonly mode?: CreateHostExecutionAuthorityLifecycleInput['mode']
  readonly before?: Partial<
    Record<WriteStage | 'facts' | 'recovery' | 'runtime', () => void | Promise<void>>
  >
  readonly after?: Partial<Record<WriteStage | 'recovery' | 'runtime', () => void | Promise<void>>>
  readonly driverActivate?: () => void | Promise<void>
  readonly driverRenew?: () => void | Promise<void>
  readonly deferredRecovery?: boolean
}

/** Host facts are produced by the fixture driver, never decoded from the reference. */
function fixture(db: ProviderNeutralDatabase, options: FixtureOptions = {}) {
  const events: string[] = [],
    failures: unknown[] = [],
    received: HostExecutionGrantContext[] = [],
    receipts: HostExecutionWriteReceipt[] = []
  const waiters = new Map<string, (() => void)[]>()
  const record = (event: string) => {
    events.push(event)
    for (const resolve of waiters.get(event) ?? []) resolve()
    waiters.delete(event)
  }
  const waitFor = (event: string): Promise<void> =>
    events.includes(event)
      ? Promise.resolve()
      : new Promise((resolve) => waiters.set(event, [...(waiters.get(event) ?? []), resolve]))
  const leases = new Map<object, { holder: string; expiresAt: number }>()
  const opaque = () =>
    new Proxy(Object.freeze({}), {
      get() {
        throw new Error('host reference must remain opaque')
      },
      ownKeys() {
        throw new Error('host reference must remain opaque')
      },
    })
  let sequence = 0,
    observer: Parameters<HostExecutionAuthorityDriver['subscribe']>[0] | undefined,
    activeContext: HostExecutionGrantContext | undefined
  const grantReference = () => {
    const reference = opaque()
    leases.set(reference, {
      holder: `actual-fixture-holder-${++sequence}`,
      expiresAt: Date.now() + 60_000,
    })
    return reference
  }
  const original = composeHostExecutionWriteContext(db)
  const taskWrites = createTaskHostWriteContextAdapter(original)
  const writeContext: HostExecutionWriteContext = {
    async prepare(input) {
      expect<HostExecutionWriteContext>(this).toBe(writeContext)
      record('write.prepare')
      received.push(input.context)
      activeContext = input.context
      await options.before?.prepare?.()
      const receipt = await original.context.prepare.call(original.context, input)
      receipts.push(receipt)
      record('write.prepare.commit')
      await options.after?.prepare?.()
      record('write.prepare.ack')
      return receipt
    },
    forGrant(input) {
      return original.context.forGrant.call(original.context, input)
    },
    async activate(receipt) {
      expect<HostExecutionWriteContext>(this).toBe(writeContext)
      record('write.activate')
      await options.before?.activate?.()
      await original.context.activate.call(original.context, receipt)
      record('write.activate.commit')
      await options.after?.activate?.()
      record('write.activate.ack')
    },
    async renew(receipt, expiresAt) {
      expect<HostExecutionWriteContext>(this).toBe(writeContext)
      record('write.renew')
      expect(receipts).toContain(receipt)
      await options.before?.renew?.()
      await original.context.renew.call(original.context, receipt, expiresAt)
      await options.after?.renew?.()
      record('write.renew.ack')
    },
    async drain(receipt) {
      expect<HostExecutionWriteContext>(this).toBe(writeContext)
      record('write.drain')
      expect(receipts).toContain(receipt)
      await options.before?.drain?.()
      await original.context.drain.call(original.context, receipt)
      await options.after?.drain?.()
      record('write.drain.ack')
    },
    async retire(receipt) {
      expect<HostExecutionWriteContext>(this).toBe(writeContext)
      record('write.retire')
      expect(receipts).toContain(receipt)
      await options.before?.retire?.()
      await original.context.retire.call(original.context, receipt)
      record('write.retire.commit')
      await options.after?.retire?.()
      record('write.retire.ack')
    },
  }
  const facts: HostExecutionWriteLeaseFacts = {
    async forGrant(context) {
      expect<HostExecutionWriteLeaseFacts>(this).toBe(facts)
      record('facts')
      await options.before?.facts?.()
      const lease = leases.get(context.reference)
      if (!lease) throw new Error('fixture host grant missing')
      return { ...lease }
    },
  }
  const writeLifecycle = composeHostExecutionWriteLifecycle({ context: writeContext, facts })
  const driver: HostExecutionAuthorityDriver = {
    claim() {
      record('driver.claim')
      return { kind: 'granted', reference: grantReference() }
    },
    async renew(reference) {
      record('driver.renew')
      await options.driverRenew?.()
      const lease = leases.get(reference)!
      leases.set(reference, { ...lease, expiresAt: lease.expiresAt + 60_000 })
      return { kind: 'granted', reference }
    },
    async activate({ reference }) {
      record('driver.activate')
      await options.driverActivate?.()
      return { kind: 'granted', reference }
    },
    quiesce() {
      record('driver.quiesce')
    },
    release() {
      record('driver.release')
    },
    subscribe(input) {
      record('driver.subscribe')
      observer = input
      return {
        close() {
          record('driver.subscription.close')
        },
      }
    },
  }
  const insert = async (tx: ProviderNeutralDatabase, id: string) => {
    await tx
      .insert(workflows)
      .values({ id, name: id, description: '', definition: '{}', version: 1, schemaVersion: 4 })
  }
  const input: CreateHostExecutionAuthorityLifecycleInput = {
    generation: 'so-write-lifecycle-generation',
    mode: options.mode ?? 'execution',
    driver,
    writeLifecycle,
    recovery: {
      kind: 'durable-intent',
      async prepare(context) {
        record('recovery.prepare')
        expect(context).toBe(activeContext)
        expect((await db.select().from(hostExecutionWriteContexts))[0]?.phase).toBe('preparing')
        const captured = taskWrites.port.capture(context)
        await withTaskExecutionWrite(db, async (tx) => {
          await insert(tx, `recovery-${sequence}`)
          await taskWrites.port.consumeRecovery(taskWrites.transactionFor(tx), captured)
        })
        await options.before?.recovery?.()
        await options.after?.recovery?.()
        record('recovery.prepare.ack')
        return options.deferredRecovery
          ? { kind: 'deferred', reason: 'fixture-recovery-not-ready' }
          : {
              kind: 'prepared',
              preparationDigest: 'actual-fixture-recovery',
              acceptedTaskContractVersions: ['task-intent:v1'],
              readyGroups: ['task'],
            }
      },
      quiesce() {
        record('recovery.quiesce')
      },
      drain() {
        record('recovery.drain')
      },
    },
    runtime: {
      async start({ context }) {
        record('runtime.start')
        expect(context).toBe(activeContext)
        expect((await db.select().from(hostExecutionWriteContexts))[0]?.phase).toBe('active')
        await options.before?.runtime?.()
        const captured = taskWrites.port.capture(context)
        await withTaskExecutionWrite(db, async (tx) => {
          await insert(tx, `runtime-${sequence}`)
          await taskWrites.port.consumeNewWork(taskWrites.transactionFor(tx), captured)
        })
        await options.after?.runtime?.()
        record('runtime.start.ack')
      },
      quiesce() {
        record('runtime.quiesce')
      },
      drain() {
        record('runtime.drain')
      },
    },
    onFailure(error) {
      failures.push(error)
    },
  }
  const lifecycle = createHostExecutionAuthorityLifecycle(input)
  const observe = (observation: HostExecutionAuthorityObservation) => {
    if (!observer) throw new Error('fixture subscription missing')
    observer.onObservation(observation)
  }
  const context = () => {
    if (!activeContext) throw new Error('fixture context missing')
    return activeContext
  }
  return {
    lifecycle,
    input,
    original,
    taskWrites,
    writeContext,
    facts,
    writeLifecycle,
    events,
    failures,
    received,
    receipts,
    record,
    waitFor,
    context,
    leases,
    insert,
    count: (event: string) => events.filter((value) => value === event).length,
    row: async () => (await db.select().from(hostExecutionWriteContexts))[0],
    lose: () => observe({ kind: 'lost', reason: 'fixture-authority-lost' }),
    observeRenewal() {
      const reference = context().reference,
        lease = leases.get(reference)!
      leases.set(reference, { ...lease, expiresAt: lease.expiresAt + 60_000 })
      observe({ kind: 'granted', reference })
    },
    replace: () => observe({ kind: 'granted', reference: grantReference() }),
  }
}

function originalFailures(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(originalFailures) : [error]
}

describeEachProvider('RFC-370 SO actual host write lifecycle ACKs', (harness) => {
  test('W01 resource-only construction and queries have zero host or write effects', async () => {
    const h = fixture(harness.db, { mode: 'resource-only' })
    await h.lifecycle.start()
    await h.lifecycle.renew()
    expect(h.lifecycle.queries.snapshot().reason).toBe('host-execution-resource-only')
    await h.lifecycle.close()
    expect(h.events).toEqual([])
    expect(await h.row()).toBeUndefined()
  })

  test('W02 real recovery and runtime writes wait for prepare, activate and start ACKs', async () => {
    const prepared = deferred(),
      activated = deferred(),
      started = deferred()
    const h = fixture(harness.db, {
      after: {
        prepare: () => prepared.promise,
        activate: () => activated.promise,
        runtime: () => started.promise,
      },
    })
    const starting = h.lifecycle.start()
    try {
      await h.waitFor('write.prepare.commit')
      expect((await h.row())?.phase).toBe('preparing')
      expect(h.events).not.toContain('recovery.prepare')
      expect(h.lifecycle.admission.acquire('task').kind).toBe('unavailable')
      prepared.resolve()
      await h.waitFor('write.activate.commit')
      expect(h.events.indexOf('write.prepare.ack')).toBeLessThan(
        h.events.indexOf('recovery.prepare'),
      )
      expect(h.events.indexOf('recovery.prepare.ack')).toBeLessThan(
        h.events.indexOf('driver.activate'),
      )
      expect(h.events).not.toContain('runtime.start')
      activated.resolve()
      await h.waitFor('runtime.start')
      expect(h.lifecycle.admission.acquire('task').kind).toBe('unavailable')
      started.resolve()
      await starting
      expect(h.lifecycle.queries.snapshot().phase).toBe('active')
      const admitted = h.lifecycle.admission.acquire('task')
      expect(admitted.kind).toBe('admitted')
      if (admitted.kind !== 'admitted') throw new Error(admitted.reason)
      admitted.lease.complete()
      expect(
        (
          await harness.db
            .select()
            .from(workflows)
            .where(inArray(workflows.id, ['recovery-1', 'runtime-1']))
        )
          .map((row) => row.id)
          .sort(),
      ).toEqual(['recovery-1', 'runtime-1'])
    } finally {
      prepared.resolve()
      activated.resolve()
      started.resolve()
      await starting
      await h.lifecycle.close()
    }
  })

  test('W03 complete selections reject missing methods before factory, claim or write effects', async () => {
    const h = fixture(harness.db)
    let factories = 0
    for (const method of ['prepare', 'activate', 'renew', 'quiesce', 'retire'] as const) {
      const incomplete = {
        ...h.writeLifecycle,
        [method]: undefined,
      } as unknown as HostExecutionWriteLifecycle
      expect(() =>
        createHostExecutionAuthorityLifecycle({ ...h.input, writeLifecycle: incomplete }),
      ).toThrow(`host-execution-write-lifecycle-missing-${method}`)
      expect(() =>
        composeHostExecutionAuthorityBinding({
          provider: harness.applicationBinding.provider,
          generation: 'selection-check',
          mode: 'execution',
          onFailure() {},
          selection: {
            kind: 'selected',
            recovery: h.input.recovery,
            runtime: h.input.runtime,
            writeLifecycle: incomplete,
            factory: {
              create() {
                factories++
                return h.input.driver
              },
            },
          },
        }),
      ).toThrow(`host-execution-write-lifecycle-missing-${method}`)
    }
    for (const method of ['prepare', 'activate', 'renew', 'drain', 'retire'] as const) {
      expect(() =>
        composeHostExecutionWriteLifecycle({
          context: {
            ...h.writeContext,
            [method]: undefined,
          } as unknown as HostExecutionWriteContext,
          facts: h.facts,
        }),
      ).toThrow(`host-execution-write-context-missing-${method}`)
    }
    expect(() =>
      composeHostExecutionWriteLifecycle({
        context: h.writeContext,
        facts: {} as HostExecutionWriteLeaseFacts,
      }),
    ).toThrow('host-execution-write-lease-facts-missing-forGrant')
    expect(factories).toBe(0)
    expect(h.events).toEqual([])
    expect(await h.row()).toBeUndefined()
    await h.lifecycle.close()
  })

  test('W04 original callback receivers, opaque grant and receipt survive method replacement', async () => {
    const h = fixture(harness.db)
    const forbidden = () => {
      throw new Error('replacement callback must not run')
    }
    for (const method of ['prepare', 'activate', 'renew', 'drain', 'retire'] as const) {
      Object.defineProperty(h.writeContext, method, { value: forbidden, configurable: true })
    }
    Object.defineProperty(h.facts, 'forGrant', { value: forbidden, configurable: true })
    await h.lifecycle.start()
    const before = await h.row()
    await h.lifecycle.renew()
    expect(h.received).toEqual([h.context()])
    expect(h.receipts).toHaveLength(1)
    expect(h.taskWrites.port.capture(h.context())).toBe(h.taskWrites.port.capture(h.context()))
    expect((await h.row())?.revision).toBe(before?.revision)
    await h.lifecycle.close()
    expect((await h.row())?.phase).toBe('closed')
    expect(h.failures).toEqual([])
  })

  test('W05 explicit renewal persists actual new expiry without preparation or restart', async () => {
    const h = fixture(harness.db)
    await h.lifecycle.start()
    const before = (await h.row())!
    await h.lifecycle.renew()
    expect(await h.row()).toMatchObject({
      revision: before.revision,
      holder: before.holder,
      expiresAt: before.expiresAt + 60_000,
      phase: 'active',
    })
    expect(h.count('driver.renew')).toBe(1)
    expect(h.count('write.renew')).toBe(1)
    expect(h.count('write.prepare')).toBe(1)
    expect(h.count('runtime.start')).toBe(1)
    await h.lifecycle.close()
  })

  test('W06 same-reference observation updates durable expiry through the original queue', async () => {
    const h = fixture(harness.db)
    await h.lifecycle.start()
    const before = (await h.row())!
    h.observeRenewal()
    await h.lifecycle.settled()
    expect((await h.row())?.expiresAt).toBe(before.expiresAt + 60_000)
    expect(h.count('driver.renew')).toBe(0)
    expect(h.count('write.renew')).toBe(1)
    expect(h.count('write.prepare')).toBe(1)
    expect(h.count('write.activate')).toBe(1)
    expect(h.count('runtime.start')).toBe(1)
    await h.lifecycle.close()
  })

  test('W07 a preparing observation waits for the original preparation and activation', async () => {
    const recovered = deferred()
    const h = fixture(harness.db, { after: { recovery: () => recovered.promise } })
    const starting = h.lifecycle.start()
    try {
      await h.waitFor('recovery.prepare')
      const before = (await h.row())!
      h.observeRenewal()
      await nextTurn()
      expect(h.count('write.renew')).toBe(0)
      expect(h.count('runtime.start')).toBe(0)
      recovered.resolve()
      await starting
      await h.lifecycle.settled()
      expect((await h.row())?.expiresAt).toBe(before.expiresAt + 60_000)
      expect(h.events.indexOf('runtime.start.ack')).toBeLessThan(h.events.indexOf('write.renew'))
      expect(h.count('write.prepare')).toBe(1)
      expect(h.count('runtime.start')).toBe(1)
    } finally {
      recovered.resolve()
      await starting
      await h.lifecycle.close()
    }
  })

  test('W08 old admitted result commits while draining before write retire or driver release', async () => {
    const h = fixture(harness.db)
    await h.lifecycle.start()
    const captured = h.taskWrites.port.capture(h.context())
    const admitted = h.lifecycle.admission.acquire('task')
    if (admitted.kind !== 'admitted') throw new Error(admitted.reason)
    let closed = false
    const closing = h.lifecycle.close().then(() => {
      closed = true
    })
    try {
      await h.waitFor('write.drain.ack')
      await h.waitFor('recovery.drain')
      expect(h.lifecycle.admission.acquire('task').kind).toBe('unavailable')
      expect(await admitted.lease.stopped).toBe('shutdown')
      expect((await h.row())?.phase).toBe('draining')
      expect(h.events).not.toContain('write.retire')
      expect(h.events).not.toContain('driver.release')
      expect(closed).toBe(false)
      await withTaskExecutionWrite(harness.db, async (tx) => {
        await h.insert(tx, 'old-admitted-result')
        await h.taskWrites.port.consumeIssuedAck(h.taskWrites.transactionFor(tx), captured)
      })
      h.record('task.result.commit')
      expect(
        await harness.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, 'old-admitted-result')),
      ).toEqual([{ id: 'old-admitted-result' }])
      admitted.lease.complete()
      await closing
      expect(h.events.indexOf('task.result.commit')).toBeLessThan(h.events.indexOf('write.retire'))
      expect(h.events.indexOf('write.retire.ack')).toBeLessThan(h.events.indexOf('driver.release'))
      expect((await h.row())?.phase).toBe('closed')
    } finally {
      admitted.lease.complete()
      await closing
    }
  })

  test('W09 a replacement waits for every old admission ACK and preserves receipt generations', async () => {
    const h = fixture(harness.db)
    await h.lifecycle.start()
    const first = (await h.row())!
    const admitted = h.lifecycle.admission.acquire('task')
    if (admitted.kind !== 'admitted') throw new Error(admitted.reason)
    h.replace()
    try {
      await h.waitFor('recovery.drain')
      expect(h.count('write.prepare')).toBe(1)
      expect(h.count('driver.release')).toBe(0)
      expect((await h.row())?.phase).toBe('draining')
      admitted.lease.complete()
      await h.lifecycle.settled()
      expect((await h.row())?.revision).toBe(first.revision + 1)
      expect(h.receipts[1]).not.toBe(h.receipts[0])
      expect(h.count('write.prepare')).toBe(2)
      expect(h.events.indexOf('driver.release')).toBeLessThan(h.events.lastIndexOf('write.prepare'))
    } finally {
      admitted.lease.complete()
      await h.lifecycle.close()
    }
  })

  test('W10 failed write quiesce retries only unfinished control steps', async () => {
    const failure = new Error('fixture-drain-rejected')
    let first = true
    const h = fixture(harness.db, {
      before: {
        drain() {
          if (first) {
            first = false
            throw failure
          }
        },
      },
    })
    await h.lifecycle.start()
    await expect(h.lifecycle.close()).rejects.toBe(failure)
    expect(h.count('driver.release')).toBe(0)
    expect(h.count('write.retire')).toBe(0)
    expect(h.count('runtime.quiesce')).toBe(1)
    expect(h.count('recovery.drain')).toBe(1)
    expect(h.lifecycle.queries.snapshot().phase).toBe('draining')
    await h.lifecycle.close()
    expect(h.count('write.drain')).toBe(2)
    for (const stage of [
      'driver.quiesce',
      'runtime.quiesce',
      'recovery.quiesce',
      'runtime.drain',
      'recovery.drain',
      'write.retire',
      'driver.release',
    ])
      expect(h.count(stage)).toBe(1)
    expect((await h.row())?.phase).toBe('closed')
  })

  test('W11 failed retire ACK retains the old grant even after its durable closed commit', async () => {
    const failure = new Error('fixture-retire-ack-rejected')
    let first = true
    const h = fixture(harness.db, {
      after: {
        retire() {
          if (first) {
            first = false
            throw failure
          }
        },
      },
    })
    await h.lifecycle.start()
    await expect(h.lifecycle.close()).rejects.toBe(failure)
    expect((await h.row())?.phase).toBe('closed')
    expect(h.lifecycle.queries.snapshot().phase).toBe('draining')
    expect(h.count('driver.release')).toBe(0)
    await h.lifecycle.close()
    expect(h.count('write.retire')).toBe(2)
    expect(h.count('write.drain')).toBe(1)
    expect(h.count('driver.release')).toBe(1)
    expect(h.lifecycle.queries.snapshot().phase).toBe('closed')
  })

  test('W12 lost held prepare ACK closes its exact receipt without recovery or start', async () => {
    const prepared = deferred()
    const h = fixture(harness.db, { after: { prepare: () => prepared.promise } })
    const starting = h.lifecycle.start()
    await h.waitFor('write.prepare.commit')
    const closing = h.lifecycle.close()
    expect((await h.row())?.phase).toBe('preparing')
    expect(h.count('write.drain')).toBe(0)
    prepared.resolve()
    await starting
    await closing
    expect(h.count('recovery.prepare')).toBe(0)
    expect(h.count('runtime.start')).toBe(0)
    expect(h.count('write.drain')).toBe(1)
    expect(h.count('write.retire')).toBe(1)
    expect(h.count('driver.release')).toBe(1)
    expect((await h.row())?.phase).toBe('closed')
  })

  test('W13 loss while facts are pending performs no durable prepare', async () => {
    const facts = deferred()
    const h = fixture(harness.db, { before: { facts: () => facts.promise } })
    const starting = h.lifecycle.start()
    await h.waitFor('facts')
    const closing = h.lifecycle.close()
    facts.resolve()
    await starting
    await closing
    expect(h.count('write.prepare')).toBe(0)
    expect(h.count('write.drain')).toBe(0)
    expect(h.count('write.retire')).toBe(0)
    expect(h.count('driver.release')).toBe(1)
    expect(await h.row()).toBeUndefined()
  })

  test('W14 facts rejection before prepare retires without inventing an unsettled receipt', async () => {
    const failure = new Error('fixture-facts-rejected')
    let first = true
    const h = fixture(harness.db, {
      before: {
        facts() {
          if (first) {
            first = false
            throw failure
          }
        },
      },
    })
    await expect(h.lifecycle.start()).rejects.toBe(failure)
    expect(h.count('write.prepare')).toBe(0)
    expect(h.count('driver.release')).toBe(1)
    expect(await h.row()).toBeUndefined()
    await h.lifecycle.start()
    expect((await h.row())?.revision).toBe(1)
    await h.lifecycle.close()
  })

  test('W15 invoked prepare rejection keeps unknown commit unsettled and blocks the next grant', async () => {
    const failure = new Error('fixture-prepare-ack-unknown')
    const h = fixture(harness.db, {
      after: {
        prepare() {
          throw failure
        },
      },
    })
    const result = await h.lifecycle.start().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    )
    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') throw new Error('prepare failure swallowed')
    expect(originalFailures(result.error)).toContain(failure)
    expect((await h.row())?.phase).toBe('preparing')
    expect(h.count('driver.release')).toBe(0)
    expect(h.count('recovery.prepare')).toBe(0)
    await h.lifecycle.start().then(
      () => {
        throw new Error('unsettled prepare was silently accepted')
      },
      (error: unknown) => expect(originalFailures(error)).toContain(failure),
    )
    await h.lifecycle.close().then(
      () => {
        throw new Error('unsettled prepare was silently retired')
      },
      (error: unknown) => expect(originalFailures(error)).toContain(failure),
    )
    expect(h.count('driver.claim')).toBe(1)
    expect(h.count('write.prepare')).toBe(1)
    expect(h.count('driver.release')).toBe(0)
    expect(h.lifecycle.queries.snapshot().phase).toBe('draining')
  })

  test('W16 a pre-existing nonclosed durable row remains unavailable while resources stay usable', async () => {
    const prior = {
      id: 'installation',
      holder: 'prior-host',
      generation: 'prior-generation',
      revision: 9,
      phase: 'active' as const,
      expiresAt: 0,
      updatedAt: 1,
    }
    await harness.db.insert(hostExecutionWriteContexts).values(prior)
    const h = fixture(harness.db)
    const result = await h.lifecycle.start().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    )
    expect(result.kind).toBe('rejected')
    expect(await h.row()).toEqual(prior)
    expect(h.count('runtime.start')).toBe(0)
    expect(h.count('driver.release')).toBe(0)
    await h.insert(harness.db, 'resource-edit-without-execution')
    expect(
      await harness.db
        .select({ id: workflows.id })
        .from(workflows)
        .where(eq(workflows.id, 'resource-edit-without-execution')),
    ).toEqual([{ id: 'resource-edit-without-execution' }])
    await h.lifecycle.close().then(
      () => {
        throw new Error('prior unresolved grant closed')
      },
      () => undefined,
    )
    expect(await h.row()).toEqual(prior)
  })

  test('W17 explicit write renewal failure closes admission and retires the exact old receipt', async () => {
    const failure = new Error('fixture-write-renew-rejected')
    const h = fixture(harness.db, {
      before: {
        renew() {
          throw failure
        },
      },
    })
    await h.lifecycle.start()
    await expect(h.lifecycle.renew()).rejects.toBe(failure)
    expect(h.lifecycle.admission.acquire('task').kind).toBe('unavailable')
    expect(h.count('write.prepare')).toBe(1)
    expect(h.count('write.retire')).toBe(1)
    expect((await h.row())?.phase).toBe('closed')
    await h.lifecycle.close()
  })

  test('W18 observation renewal failure is visible through settlement and stops new work', async () => {
    const failure = new Error('fixture-observed-renew-rejected')
    const h = fixture(harness.db, {
      before: {
        renew() {
          throw failure
        },
      },
    })
    await h.lifecycle.start()
    h.observeRenewal()
    await expect(h.lifecycle.settled()).rejects.toBe(failure)
    expect(h.failures).toEqual([failure])
    expect(h.lifecycle.admission.acquire('task').kind).toBe('unavailable')
    expect((await h.row())?.phase).toBe('closed')
    await h.lifecycle.close()
  })

  test('W19 loss after durable activation ACK closes the receipt before any runtime start', async () => {
    const activated = deferred()
    const h = fixture(harness.db, { after: { activate: () => activated.promise } })
    const starting = h.lifecycle.start()
    await h.waitFor('write.activate.commit')
    h.lose()
    activated.resolve()
    await starting
    await h.lifecycle.settled()
    expect(h.count('runtime.start')).toBe(0)
    expect(h.count('write.retire')).toBe(1)
    expect((await h.row())?.phase).toBe('closed')
    await h.lifecycle.close()
  })

  test('W20 deferred recovery closes preparing writes without platform activate or runtime start', async () => {
    const h = fixture(harness.db, { deferredRecovery: true })
    await h.lifecycle.start()
    expect(h.lifecycle.queries.snapshot().reason).toBe('fixture-recovery-not-ready')
    expect(h.count('driver.activate')).toBe(0)
    expect(h.count('runtime.start')).toBe(0)
    expect((await h.row())?.phase).toBe('closed')
    await h.lifecycle.close()
  })

  test('W21 async authority factory retains the original complete write selection', async () => {
    const h = fixture(harness.db)
    const created = deferred<HostExecutionAuthorityDriver>()
    const calls: string[] = []
    const mutableWrites: HostExecutionWriteLifecycle = {
      prepare(context) {
        expect<HostExecutionWriteLifecycle>(this).toBe(mutableWrites)
        calls.push('prepare')
        return h.writeLifecycle.prepare(context)
      },
      activate(context) {
        expect<HostExecutionWriteLifecycle>(this).toBe(mutableWrites)
        calls.push('activate')
        return h.writeLifecycle.activate(context)
      },
      renew(context) {
        expect<HostExecutionWriteLifecycle>(this).toBe(mutableWrites)
        calls.push('renew')
        return h.writeLifecycle.renew(context)
      },
      quiesce(context) {
        expect<HostExecutionWriteLifecycle>(this).toBe(mutableWrites)
        calls.push('quiesce')
        return h.writeLifecycle.quiesce(context)
      },
      retire(context) {
        expect<HostExecutionWriteLifecycle>(this).toBe(mutableWrites)
        calls.push('retire')
        return h.writeLifecycle.retire(context)
      },
    }
    const selection: HostExecutionAuthoritySelection = {
      kind: 'selected',
      factory: { create: () => created.promise },
      recovery: h.input.recovery,
      runtime: h.input.runtime,
      writeLifecycle: mutableWrites,
    }
    const pending = composeHostExecutionAuthorityBinding({
      provider: harness.applicationBinding.provider,
      generation: h.input.generation,
      mode: 'execution',
      selection,
      onFailure(error) {
        throw error
      },
    })
    const replacedCallback = () => {
      throw new Error('replaced write callback must not run')
    }
    for (const method of ['prepare', 'activate', 'renew', 'quiesce', 'retire'] as const) {
      Object.defineProperty(mutableWrites, method, { value: replacedCallback })
    }
    Reflect.deleteProperty(mutableWrites, 'renew')
    Object.defineProperty(selection, 'writeLifecycle', { value: undefined })
    created.resolve(h.input.driver)
    const binding = await pending
    await binding.lifecycle.start()
    expect(h.count('write.prepare')).toBe(1)
    expect(h.count('write.activate')).toBe(1)
    expect((await h.row())?.phase).toBe('active')
    const active = (await h.row())!
    await binding.lifecycle.renew()
    expect(h.count('write.renew')).toBe(1)
    expect((await h.row())?.expiresAt).toBeGreaterThan(active.expiresAt)
    await binding.lifecycle.close()
    await h.lifecycle.close()
    expect(calls).toEqual(['prepare', 'activate', 'renew', 'quiesce', 'retire'])
    expect((await h.row())?.phase).toBe('closed')
  })

  test('W22 changed holder facts stop renewal and retain the original receipt identity', async () => {
    const h = fixture(harness.db)
    await h.lifecycle.start()
    const before = (await h.row())!
    h.leases.set(h.context().reference, {
      holder: 'different-host-holder',
      expiresAt: before.expiresAt + 60_000,
    })
    await expect(h.lifecycle.renew()).rejects.toThrow('host-execution-write-lease-holder-mismatch')
    expect(h.count('write.renew')).toBe(0)
    expect(h.receipts).toHaveLength(1)
    expect(await h.row()).toMatchObject({
      holder: before.holder,
      revision: before.revision,
      expiresAt: before.expiresAt,
      phase: 'closed',
    })
    await h.lifecycle.close()
  })

  test('W23 loss during renewal facts ACK skips the durable renewal and drains the old receipt', async () => {
    const entered = deferred(),
      renewed = deferred()
    let factsCalls = 0
    const h = fixture(harness.db, {
      before: {
        facts() {
          if (++factsCalls === 2) {
            entered.resolve()
            return renewed.promise
          }
        },
      },
    })
    await h.lifecycle.start()
    const before = (await h.row())!
    const renewing = h.lifecycle.renew()
    await entered.promise
    h.lose()
    renewed.resolve()
    await renewing
    await h.lifecycle.settled()
    expect(h.count('write.renew')).toBe(0)
    expect(await h.row()).toMatchObject({ expiresAt: before.expiresAt, phase: 'closed' })
    expect(h.lifecycle.admission.acquire('task').kind).toBe('unavailable')
    await h.lifecycle.close()
  })

  test('W24 loss during platform activation ACK never activates durable writes or runtime', async () => {
    const activated = deferred()
    const h = fixture(harness.db, { driverActivate: () => activated.promise })
    const starting = h.lifecycle.start()
    await h.waitFor('driver.activate')
    h.lose()
    activated.resolve()
    await starting
    await h.lifecycle.settled()
    expect(h.count('write.activate')).toBe(0)
    expect(h.count('runtime.start')).toBe(0)
    expect((await h.row())?.phase).toBe('closed')
    expect(h.count('write.retire')).toBe(1)
    await h.lifecycle.close()
  })

  test('W25 undefined prepare rejection remains an unsettled failure after its actual commit', async () => {
    const h = fixture(harness.db, {
      after: {
        prepare() {
          throw undefined
        },
      },
    })
    const result = await h.lifecycle.start().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    )
    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') throw new Error('undefined prepare failure swallowed')
    expect(originalFailures(result.error)).toContain(undefined)
    expect((await h.row())?.phase).toBe('preparing')
    expect(h.count('driver.release')).toBe(0)
    await h.lifecycle.close().then(
      () => {
        throw new Error('undefined unresolved prepare closed')
      },
      (error: unknown) => expect(originalFailures(error)).toContain(undefined),
    )
    expect(h.lifecycle.queries.snapshot().phase).toBe('draining')
    expect(h.count('write.prepare')).toBe(1)
    expect(h.count('driver.release')).toBe(0)
  })
})
