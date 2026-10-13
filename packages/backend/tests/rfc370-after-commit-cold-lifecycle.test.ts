import { spawnSync } from 'node:child_process'
import { expect, test } from 'bun:test'

import {
  createAfterCommitEventPump,
  createColdAfterCommitEventPump,
} from '@/platform/events/committed/afterCommitEventPump'
import type { CommittedEventDeliveryPersistencePort } from '@/platform/events/committed/persistence'
import {
  publishCommittedEventsAfterCommit,
  registerAfterCommitEventPump,
  releaseAfterCommitEventPump,
} from '@/platform/events/committed/runtime'
import {
  createCommittedEventProjectionLedger,
  type CommittedEventConsumerDefinition,
  type CommittedEventEnvelopeV1,
  type CommittedEventRef,
  type StoredCommittedEvent,
} from '@/platform/events/committed/types'
import { eventually } from './helpers/eventually'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function lifetime() {
  return {
    valid: true,
    current() {
      return this.valid
    },
  }
}

function stored(id: string, ordinal: number): StoredCommittedEvent {
  const envelope: CommittedEventEnvelopeV1 = {
    eventId: id,
    eventGroupId: 'group:after-commit-cold',
    eventGroupOrdinal: ordinal,
    type: 'fixture.after-commit-cold.v1',
    schemaVersion: 1,
    producer: 'collaboration',
    family: 'review',
    aggregate: { kind: 'review-round', id: 'review:after-commit-cold', seq: ordinal + 1 },
    operationRef: `operation:${id}`,
    correlationRef: null,
    causationRef: null,
    occurredAt: '2026-10-12T00:00:00.000Z',
    payload: { id },
  }
  return {
    envelope,
    payloadJson: JSON.stringify(envelope.payload),
    payloadDigest: `digest:${id}`,
    deliveryMode: 'dispatchable',
    producerEpoch: 1,
    createdAt: 1,
  }
}

function ref(event: StoredCommittedEvent): CommittedEventRef {
  return {
    eventId: event.envelope.eventId,
    payloadDigest: event.payloadDigest,
    producer: event.envelope.producer,
    family: event.envelope.family,
    aggregate: event.envelope.aggregate,
    eventGroupId: event.envelope.eventGroupId,
    eventGroupOrdinal: event.envelope.eventGroupOrdinal,
    deliveryMode: event.deliveryMode,
    producerEpoch: event.producerEpoch,
  }
}

function fixture(
  options: {
    readWait?: ReturnType<typeof deferred>
    projectWait?: ReturnType<typeof deferred>
    readError?: Error
    projectError?: Error
    nudgeError?: Error
  } = {},
) {
  const events = [stored('event:first', 0), stored('event:second', 1), stored('event:third', 2)]
  const order: string[] = []
  const reads: string[][] = []
  const errors: unknown[] = []
  let nudges = 0
  const persistence: CommittedEventDeliveryPersistencePort = {
    async getStored(ids) {
      expect(this).toBe(persistence)
      reads.push([...ids])
      await options.readWait?.promise
      if (options.readError) throw options.readError
      return events.filter((event) => ids.includes(event.envelope.eventId))
    },
    async claimNext() {
      throw new Error('claim is not owned by this immediate projection fixture')
    },
    async accept() {
      throw new Error('accept is not owned by this immediate projection fixture')
    },
    async reject() {
      throw new Error('reject is not owned by this immediate projection fixture')
    },
    async retry() {
      throw new Error('retry is not owned by this immediate projection fixture')
    },
    async deliveryPage() {
      throw new Error('delivery page is not owned by this immediate projection fixture')
    },
    async health() {
      throw new Error('health is not owned by this immediate projection fixture')
    },
  }
  const codecs = {
    eventTypes: ['fixture.after-commit-cold.v1'],
    decode(raw: unknown) {
      expect(this).toBe(codecs)
      return raw as CommittedEventEnvelopeV1
    },
  }
  const projectors = ['first-projector', 'second-projector'].map((id) => {
    const projector: CommittedEventConsumerDefinition = {
      id,
      eventTypes: codecs.eventTypes,
      deliveryClass: 'ephemeral',
      settle: 'projection-attempted',
      async handle(event) {
        expect(this).toBe(projector)
        order.push(`start:${event.eventId}:${id}`)
        await options.projectWait?.promise
        if (options.projectError && id === 'first-projector') throw options.projectError
        order.push(`end:${event.eventId}:${id}`)
      },
    }
    return projector
  })
  const originalLedger = createCommittedEventProjectionLedger()
  const ledger = {
    begin(input: Parameters<typeof originalLedger.begin>[0]) {
      expect(this).toBe(ledger)
      return originalLedger.begin(input)
    },
  }
  const input = {
    persistence,
    codecs,
    projectors,
    projectionLedger: ledger,
    nudgeDispatcher() {
      expect(this).toBe(input)
      nudges += 1
      if (options.nudgeError) throw options.nudgeError
    },
    onProjectionError(error: { error: unknown }) {
      expect(this).toBe(input)
      errors.push(error.error)
    },
  }
  return { input, events, order, reads, errors, ledger, nudges: () => nudges }
}

test('cold construction and unstarted quiesce/drain/publish/nudge execute no projection or dispatcher', async () => {
  const h = fixture()
  const pump = createColdAfterCommitEventPump(h.input)
  const scope = lifetime()
  pump.nudge()
  await expect(pump.publishNow(h.events.map(ref))).rejects.toThrow(
    'after-commit execution is not ready',
  )
  await pump.quiesce(scope)
  await pump.awaitDrained(scope)
  expect(h.reads).toEqual([])
  expect(h.order).toEqual([])
  expect(h.nudges()).toBe(0)
})

test('native tracked drain waits overlapping publishes and retains execution-time method lookup', async () => {
  const readWait = deferred()
  const h = fixture({ readWait })
  const pump = createAfterCommitEventPump(h.input)
  const first = pump.publishNow([ref(h.events[0]!)])
  const second = pump.publishNow([ref(h.events[1]!)])
  await eventually(
    async () => h.reads.length,
    (count) => count === 1,
  )
  const replacementHandles: string[] = []
  let replacementNudges = 0
  Object.assign(h.input.projectors[0]!, {
    handle(event: CommittedEventEnvelopeV1) {
      replacementHandles.push(event.eventId)
    },
  })
  h.input.nudgeDispatcher = () => {
    replacementNudges += 1
  }
  let drained = false
  const draining = pump.awaitDrained().then(() => {
    drained = true
  })
  expect(drained).toBe(false)
  readWait.resolve()
  await Promise.all([first, second, draining])
  expect(h.reads).toEqual([['event:first'], ['event:second']])
  expect(replacementHandles).toEqual(['event:first', 'event:second'])
  expect(replacementNudges).toBe(2)
  expect(h.nudges()).toBe(0)
})

test('native rejected read keeps its original error and nudge while the next serial publish can proceed', async () => {
  const originalError = new Error('original native read failure')
  const h = fixture({ readError: originalError })
  const pump = createAfterCommitEventPump(h.input)
  await expect(pump.publishNow([ref(h.events[0]!)])).rejects.toBe(originalError)
  h.input.persistence.getStored = async () => [h.events[1]!]
  await pump.publishNow([ref(h.events[1]!)])
  await pump.awaitDrained()
  expect(h.nudges()).toBe(2)
  expect(h.order.filter((value) => value.startsWith('end:'))).toEqual([
    'end:event:second:first-projector',
    'end:event:second:second-projector',
  ])
})

test('cold start shares pending readiness and performs no read or nudge until explicitly published', async () => {
  const h = fixture()
  const pump = createColdAfterCommitEventPump(h.input)
  const scope = lifetime()
  const starting = pump.start(scope)
  expect(pump.start(scope)).toBe(starting)
  await expect(pump.publishNow([ref(h.events[0]!)])).rejects.toThrow(
    'after-commit execution is not ready',
  )
  await starting
  expect(h.reads).toEqual([])
  expect(h.nudges()).toBe(0)
  await pump.publishNow([ref(h.events[1]!), ref(h.events[0]!)])
  expect(h.order.filter((value) => value.startsWith('end:'))).toEqual([
    'end:event:first:first-projector',
    'end:event:first:second-projector',
    'end:event:second:first-projector',
    'end:event:second:second-projector',
  ])
  expect(h.nudges()).toBe(1)
  await pump.quiesce(scope)
  await pump.awaitDrained(scope)
})

test('loss during the real read and projector waits settles the whole admitted batch and queued publish', async () => {
  const readWait = deferred(),
    projectWait = deferred()
  const h = fixture({ readWait, projectWait })
  const pump = createColdAfterCommitEventPump(h.input)
  const scope = lifetime()
  await pump.start(scope)
  const first = pump.publishNow([ref(h.events[1]!), ref(h.events[0]!)])
  const queued = pump.publishNow([ref(h.events[2]!)])
  await eventually(
    async () => h.reads.length,
    (count) => count === 1,
  )
  scope.valid = false
  await pump.quiesce(scope)
  pump.nudge()
  await expect(pump.publishNow([])).rejects.toThrow('after-commit execution is not ready')
  let drained = false
  const draining = pump.awaitDrained(scope).then(() => {
    drained = true
  })
  readWait.resolve()
  await eventually(
    async () => h.order.length,
    (count) => count === 1,
  )
  expect(drained).toBe(false)
  expect(h.reads).toHaveLength(1)
  projectWait.resolve()
  await Promise.all([first, queued, draining])
  expect(h.order.filter((value) => value.startsWith('end:'))).toEqual([
    'end:event:first:first-projector',
    'end:event:first:second-projector',
    'end:event:second:first-projector',
    'end:event:second:second-projector',
    'end:event:third:first-projector',
    'end:event:third:second-projector',
  ])
  expect(h.reads).toEqual([['event:second', 'event:first'], ['event:third']])
  expect(h.nudges()).toBe(0)
})

test('a successor waits the original tail and a superseded lifetime cannot form a reverse start wait', async () => {
  const projectWait = deferred()
  const h = fixture({ projectWait })
  const pump = createColdAfterCommitEventPump(h.input)
  const first = lifetime(),
    second = lifetime()
  await pump.start(first)
  const publishing = pump.publishNow([ref(h.events[0]!)])
  await eventually(
    async () => h.order.length,
    (count) => count === 1,
  )
  const next = pump.start(second)
  expect(pump.start(second)).toBe(next)
  await expect(pump.start(first)).rejects.toThrow(
    'after-commit execution lifetime has been superseded',
  )
  await expect(pump.publishNow([ref(h.events[1]!)])).rejects.toThrow(
    'after-commit execution is not ready',
  )
  projectWait.resolve()
  await Promise.all([publishing, next])
  await pump.publishNow([ref(h.events[1]!)])
  expect(h.nudges()).toBe(1)
  await pump.quiesce(second)
  await pump.awaitDrained(second)
})

test('loss of the successor while awaiting old work prevents its delayed activation', async () => {
  const projectWait = deferred()
  const h = fixture({ projectWait })
  const pump = createColdAfterCommitEventPump(h.input)
  const first = lifetime(),
    second = lifetime()
  await pump.start(first)
  const publishing = pump.publishNow([ref(h.events[0]!)])
  await eventually(
    async () => h.order.length,
    (count) => count === 1,
  )
  const next = pump.start(second)
  void next.catch(() => undefined)
  second.valid = false
  await pump.quiesce(second)
  projectWait.resolve()
  await publishing
  await expect(next).rejects.toThrow('after-commit execution start quiesced')
  await pump.awaitDrained(first)
  await pump.awaitDrained(second)
  expect(h.nudges()).toBe(0)
  await expect(pump.publishNow([])).rejects.toThrow('after-commit execution is not ready')
})

test('a drain timeout preserves the original unfinished tail and a late settlement permits the successor', async () => {
  const projectWait = deferred()
  const h = fixture({ projectWait })
  const pump = createColdAfterCommitEventPump(h.input)
  const first = lifetime(),
    second = lifetime()
  await pump.start(first)
  const publishing = pump.publishNow([ref(h.events[0]!)])
  await eventually(
    async () => h.order.length,
    (count) => count === 1,
  )
  await pump.quiesce(first)
  await expect(pump.awaitDrained(first, 17)).rejects.toThrow(
    'after-commit execution actual drain timed out',
  )
  const next = pump.start(second)
  let ready = false
  void next.then(() => {
    ready = true
  })
  expect(ready).toBe(false)
  expect(h.order).toHaveLength(1)
  projectWait.resolve()
  await Promise.all([publishing, next, pump.awaitDrained(first)])
  expect(ready).toBe(true)
  await pump.quiesce(second)
  await pump.awaitDrained(second)
})

test('cold dependencies and current keep original functions and receivers across asynchronous waits', async () => {
  const readWait = deferred()
  const originalError = new Error('original bound projector failure')
  const h = fixture({ readWait, projectError: originalError })
  const pump = createColdAfterCommitEventPump(h.input)
  const scope = lifetime()
  await pump.start(scope)
  const publishing = pump.publishNow([ref(h.events[0]!)])
  await eventually(
    async () => h.reads.length,
    (count) => count === 1,
  )
  h.input.persistence.getStored = async () => {
    throw new Error('replacement read')
  }
  h.input.codecs.decode = () => {
    throw new Error('replacement codec')
  }
  h.ledger.begin = () => {
    throw new Error('replacement ledger')
  }
  for (const projector of h.input.projectors)
    Object.assign(projector, {
      handle() {
        throw new Error('replacement projector')
      },
    })
  h.input.nudgeDispatcher = () => {
    throw new Error('replacement nudge')
  }
  h.input.onProjectionError = () => {
    throw new Error('replacement projection hook')
  }
  scope.current = () => true
  readWait.resolve()
  await publishing
  expect(h.order.filter((value) => value.startsWith('end:'))).toHaveLength(1)
  expect(h.errors).toEqual([originalError])
  expect(h.nudges()).toBe(1)
  scope.valid = false
  pump.nudge()
  await expect(pump.publishNow([ref(h.events[1]!)])).rejects.toThrow(
    'after-commit execution is not ready',
  )
  await pump.quiesce(scope)
  await pump.awaitDrained(scope)
  expect(h.reads).toHaveLength(1)
  expect(h.nudges()).toBe(1)
})

test('projector failure remains an attempted ledger entry while later projectors and finally nudge retain their behavior', async () => {
  const originalError = new Error('original projector failure')
  const h = fixture({ projectError: originalError })
  const pump = createColdAfterCommitEventPump(h.input)
  const scope = lifetime()
  await pump.start(scope)
  await pump.publishNow([ref(h.events[0]!)])
  await pump.publishNow([ref(h.events[0]!)])
  expect(h.errors).toEqual([originalError])
  expect(h.order).toEqual([
    'start:event:first:first-projector',
    'start:event:first:second-projector',
    'end:event:first:second-projector',
  ])
  expect(h.nudges()).toBe(2)
  await pump.quiesce(scope)
  await pump.awaitDrained(scope)
})

test('failed reads and finally callback failures propagate without turning actual tail settlement into projection success', async () => {
  for (const kind of ['read', 'nudge'] as const) {
    const originalError = new Error(`original ${kind} error`)
    const h = fixture(
      kind === 'read' ? { readError: originalError } : { nudgeError: originalError },
    )
    const pump = createColdAfterCommitEventPump(h.input)
    const scope = lifetime()
    await pump.start(scope)
    await expect(pump.publishNow([ref(h.events[0]!)])).rejects.toBe(originalError)
    await pump.quiesce(scope)
    await pump.awaitDrained(scope)
    expect(h.nudges()).toBe(1)
    expect(h.reads).toHaveLength(1)
  }
})

test('identity release cannot clear a successor registration and the original empty and absent pump semantics remain', async () => {
  const calls: string[] = []
  const first = {
    async publishNow() {
      calls.push('first')
    },
    nudge() {},
  }
  const second = {
    async publishNow() {
      calls.push('second')
    },
    nudge() {},
  }
  try {
    registerAfterCommitEventPump(first)
    registerAfterCommitEventPump(second)
    expect(releaseAfterCommitEventPump(first)).toBe(false)
    expect(await publishCommittedEventsAfterCommit([])).toBe(true)
    await publishCommittedEventsAfterCommit([ref(stored('registered', 0))])
    expect(calls).toEqual(['second'])
    expect(releaseAfterCommitEventPump(second)).toBe(true)
    expect(releaseAfterCommitEventPump(second)).toBe(false)
    expect(await publishCommittedEventsAfterCommit([])).toBe(false)
    expect(await publishCommittedEventsAfterCommit([ref(stored('durable-only', 0))])).toBe(false)
  } finally {
    registerAfterCommitEventPump(null)
  }
})

test('three rapidly selected lifetimes retain the first actual tail without a cycle or intermediate activation', async () => {
  const projectWait = deferred()
  const h = fixture({ projectWait })
  const pump = createColdAfterCommitEventPump(h.input)
  const first = lifetime()
  const second = lifetime()
  const third = lifetime()
  await pump.start(first)
  const publishing = pump.publishNow([ref(h.events[0]!)])
  await eventually(
    async () => h.order.length,
    (count) => count === 1,
  )
  const intermediate = pump.start(second)
  void intermediate.catch(() => undefined)
  const next = pump.start(third)
  await expect(pump.start(first)).rejects.toThrow(
    'after-commit execution lifetime has been superseded',
  )
  await expect(pump.start(second)).rejects.toThrow(
    'after-commit execution lifetime has been superseded',
  )
  await expect(pump.publishNow([])).rejects.toThrow('after-commit execution is not ready')
  expect(h.order).toHaveLength(1)
  projectWait.resolve()
  await publishing
  await expect(intermediate).rejects.toThrow('after-commit execution start quiesced')
  await next
  await pump.publishNow([ref(h.events[1]!)])
  expect(h.nudges()).toBe(1)
  await Promise.all([pump.awaitDrained(first), pump.awaitDrained(second)])
  await pump.quiesce(third)
  await pump.awaitDrained(third)
})

test('completed lifetimes retain supersession identity across repeated cold starts and drains', async () => {
  const h = fixture()
  const pump = createColdAfterCommitEventPump(h.input)
  const old: ReturnType<typeof lifetime>[] = []
  for (let index = 0; index < 20; index += 1) {
    const current = lifetime()
    await pump.start(current)
    await pump.quiesce(current)
    await pump.awaitDrained(current)
    old.push(current)
  }
  const current = lifetime()
  await pump.start(current)
  for (const previous of old) {
    await expect(pump.start(previous)).rejects.toThrow(
      'after-commit execution lifetime has been superseded',
    )
  }
  expect(h.reads).toEqual([])
  expect(h.nudges()).toBe(0)
  await pump.publishNow([ref(h.events[2]!)])
  expect(h.reads).toEqual([['event:third']])
  await pump.quiesce(current)
  await pump.awaitDrained(current)
})

test('reentrant quiesce in the original current closes both startup and publish admission', async () => {
  const h = fixture()
  const pump = createColdAfterCommitEventPump(h.input)
  let close = true
  const scope = {
    current(): boolean {
      if (close) void pump.quiesce(scope)
      return true
    },
  }
  await expect(pump.start(scope)).rejects.toThrow('after-commit execution start quiesced')
  expect(h.reads).toEqual([])
  close = false
  await pump.start(scope)
  close = true
  await expect(pump.publishNow([ref(h.events[0]!)])).rejects.toThrow(
    'after-commit execution is not ready',
  )
  pump.nudge()
  expect(h.reads).toEqual([])
  expect(h.nudges()).toBe(0)
  await pump.awaitDrained(scope)
})

test('synchronous loss while the original ref filtering runs retains the admitted actual tail before successor activation', async () => {
  const projectWait = deferred()
  const h = fixture({ projectWait })
  const pump = createColdAfterCommitEventPump(h.input)
  const first = lifetime()
  const second = lifetime()
  await pump.start(first)
  let next: Promise<void> | undefined
  const eventRef = ref(h.events[0]!)
  Object.defineProperty(eventRef, 'deliveryMode', {
    get() {
      first.valid = false
      void pump.quiesce(first)
      next = pump.start(second)
      return 'dispatchable'
    },
  })
  const publishing = pump.publishNow([eventRef])
  await eventually(
    async () => h.order.length,
    (count) => count === 1,
  )
  expect(next).toBeDefined()
  await expect(pump.publishNow([ref(h.events[1]!)])).rejects.toThrow(
    'after-commit execution is not ready',
  )
  expect(h.nudges()).toBe(0)
  projectWait.resolve()
  await Promise.all([publishing, next, pump.awaitDrained(first)])
  expect(h.order.filter((value) => value.startsWith('end:'))).toHaveLength(2)
  expect(h.nudges()).toBe(0)
  await pump.quiesce(second)
  await pump.awaitDrained(second)
})

// RFC-370 SOURCE-R1 ACP-SOURCE-P2-001: a fresh Bun process has no test runner
// keeping an awaited deadline alive while its original persistence read is held.
test('an actual drain deadline rejects in a fresh process with only a pending read', () => {
  const moduleUrl = new URL(
    '../src/platform/events/committed/afterCommitEventPump.ts',
    import.meta.url,
  ).href
  const script = `
    import { createColdAfterCommitEventPump } from ${JSON.stringify(moduleUrl)};
    const unexpected = () => { throw new Error('unexpected persistence or dispatcher effect'); };
    const scope = { valid: true, current() { return this.valid; } };
    const pump = createColdAfterCommitEventPump({
      persistence: {
        getStored() { return new Promise(() => {}); },
        claimNext: unexpected,
        accept: unexpected,
        reject: unexpected,
        retry: unexpected,
        deliveryPage: unexpected,
        health: unexpected,
      },
      codecs: { eventTypes: [], decode(envelope) { return envelope; } },
      projectors: [],
      nudgeDispatcher: unexpected,
    });
    await pump.start(scope);
    void pump.publishNow([${JSON.stringify(ref(stored('event:idle-deadline', 0)))}]).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
    scope.valid = false;
    await pump.quiesce(scope);
    try {
      await pump.awaitDrained(scope, 17);
      throw new Error('actual drain incorrectly resolved');
    } catch (error) {
      if (error?.message !== 'after-commit execution actual drain timed out') throw error;
      console.log('after-commit drain deadline rejected');
    }
  `
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: import.meta.dir,
    encoding: 'utf8',
    timeout: 3_000,
    windowsHide: true,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.signal).toBeNull()
  expect(result.stderr.trim()).toBe('')
  expect(result.stdout.trim()).toBe('after-commit drain deadline rejected')
})
