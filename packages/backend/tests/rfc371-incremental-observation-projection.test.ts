// RFC-371: replacing an affected ownership component must commit all its old/new
// memberships together. Repeat delivery and rollback cannot duplicate usage.
import { expect, test } from 'bun:test'
import {
  createIncrementalObservationProjection,
  IncrementalObservationSourceChanged,
} from '@/modules/run-observability/application/incrementalObservationProjection'
import type { IncrementalObservationFold } from '@/modules/run-observability/domain/incrementalObservationFold'
import { completeIncrementalObservationFold } from '@/modules/run-observability/domain/incrementalObservationFold'
import {
  addCompleteObservationAllocation,
  completeObservationMetrics,
  emptyCompleteObservationFold,
} from '@/modules/run-observability/domain/completeObservationMetrics'
import type {
  IncrementalObservationContribution,
  IncrementalObservationProjectionStore,
  IncrementalObservationVersion,
  IncrementalObservationWork,
} from '@/modules/run-observability/ports/incrementalObservationProjection'

function row(
  key: string,
  input: string,
  aggregates = ['all', 'task:A', 'day:old'],
): IncrementalObservationContribution {
  const fold = emptyCompleteObservationFold('1')
  fold.observedInvocations = '1'
  addCompleteObservationAllocation(
    fold,
    { input, cacheRead: '2', cacheWrite: '3', output: '5' },
    { amount: '0.123456789012', complete: true, hidden: false },
  )
  return { key, component: 'native-root:A', fold, aggregates, detail: { model: 'actual-model' } }
}
function fixture() {
  const work: IncrementalObservationWork = {
    id: 'event-A',
    components: ['native-root:A'],
    source: 'source-A',
    revision: '1',
  }
  let state = {
    rows: new Map<string, IncrementalObservationContribution>(),
    aggregates: new Map<string, IncrementalObservationFold>(),
    pending: new Map([[work.id, work]]),
    head: { revision: '0', asOf: 100 } as IncrementalObservationVersion,
  }
  const reads: string[] = [],
    writes: string[] = [],
    notifications: IncrementalObservationVersion[] = []
  let source: IncrementalObservationContribution[] = [],
    failComplete = false,
    sourceCheck = 0,
    unstable = false
  const store: IncrementalObservationProjectionStore = {
    pending: async (size) => [...state.pending.values()].slice(0, size),
    async change(fn) {
      const draft = structuredClone(state)
      sourceCheck = 0
      const result = await fn({
        head: async () => draft.head,
        sourceUnchanged: async () => !(unstable && ++sourceCheck > 1),
        async *previous(item) {
          reads.push(...item.components)
          if (item.components.some((key) => !['native-root:A', 'native-root:B'].includes(key)))
            throw new Error('Unrelated component read')
          for (const value of [...draft.rows.values()]
            .filter((v) => item.components.includes(v.component))
            .sort((a, b) => (a.key < b.key ? -1 : 1)))
            yield value
        },
        putContribution: async (key, value) => {
          if (value) draft.rows.set(key, value)
          else draft.rows.delete(key)
        },
        aggregate: async (key) => draft.aggregates.get(key) ?? null,
        putAggregate: async (key, value) => {
          writes.push(key)
          draft.aggregates.set(key, value)
        },
        complete: async ({ id }) => {
          if (failComplete) throw new Error('Crash before complete')
          draft.pending.delete(id)
        },
        publish: async (version) => {
          draft.head = version
        },
      })
      state = draft
      return result
    },
  }
  const consumer = createIncrementalObservationProjection({
    store,
    now: () => 200,
    source: {
      async *contributions(_tx, item) {
        reads.push(...item.components)
        for (const value of source) yield value
      },
    },
    committed: (version) => {
      notifications.push(version)
    },
  })
  return {
    work,
    store,
    consumer,
    reads,
    writes,
    notifications,
    state: () => state,
    source: (rows: IncrementalObservationContribution[]) => {
      source = rows
    },
    crash: (value: boolean) => {
      failComplete = value
    },
    unstable: () => {
      unstable = true
    },
  }
}
function tokens(f: ReturnType<typeof fixture>, aggregate: string) {
  return completeObservationMetrics(
    completeIncrementalObservationFold(f.state().aggregates.get(aggregate)!),
  )
}

test('new and downward revised contributions touch only one component, and duplicate delivery leaves the version unchanged', async () => {
  const f = fixture()
  f.source([row('record:1', '9007199254740993')])
  expect((await f.consumer.apply(f.work)).changed).toBe(true)
  expect(f.state().head.revision).toBe('1')
  expect((await f.consumer.apply(f.work)).changed).toBe(false)
  expect(f.state().head.revision).toBe('1')
  expect(f.notifications).toHaveLength(1)
  f.source([row('record:1', '7')])
  await f.consumer.apply({ ...f.work, id: 'event-revision', revision: '2' })
  expect(f.state().head.revision).toBe('2')
  expect(tokens(f, 'all')).toMatchObject({
    state: 'ready',
    records: '1',
    invocations: '1',
    tokens: { input: '7', total: '17' },
  })
  expect(new Set(f.reads)).toEqual(new Set(['native-root:A']))
  expect(f.notifications).toHaveLength(2)
})

test('moving a contribution withdraws its old day and dimension while adding the new membership without double counting the total', async () => {
  const f = fixture()
  f.source([row('record:1', '17')])
  await f.consumer.apply(f.work)
  f.source([row('record:1', '17', ['all', 'task:B', 'day:new'])])
  await f.consumer.apply(f.work)
  expect(tokens(f, 'task:A')).toEqual({ state: 'not-applicable' })
  expect(tokens(f, 'day:old')).toEqual({ state: 'not-applicable' })
  expect(tokens(f, 'task:B')).toEqual(tokens(f, 'all'))
  expect(tokens(f, 'day:new')).toEqual(tokens(f, 'all'))
  expect(f.state().aggregates.get('all')!.counters.records).toBe('1')
})

test('moving between connected roots withdraws and adds in one committed version', async () => {
  const f = fixture()
  f.source([row('record:1', '19')])
  await f.consumer.apply(f.work)
  f.source([{ ...row('record:1', '19', ['all', 'task:B', 'day:new']), component: 'native-root:B' }])
  await f.consumer.apply({ ...f.work, components: ['native-root:A', 'native-root:B'] })
  expect(f.state().head.revision).toBe('2')
  expect(f.notifications.map((value) => value.revision)).toEqual(['1', '2'])
  expect(f.state().rows.get('record:1')!.component).toBe('native-root:B')
  expect(f.state().aggregates.get('all')!.counters.records).toBe('1')
  expect(tokens(f, 'task:A')).toEqual({ state: 'not-applicable' })
  expect(tokens(f, 'task:B')).toEqual(tokens(f, 'all'))
})

test('a crash before acknowledgment rolls back every contribution, bucket, version and pending work; replay applies once', async () => {
  const f = fixture()
  f.source([row('record:1', '31')])
  f.crash(true)
  await expect(f.consumer.apply(f.work)).rejects.toThrow('Crash before complete')
  expect(f.state().rows.size).toBe(0)
  expect(f.state().aggregates.size).toBe(0)
  expect(f.state().head.revision).toBe('0')
  expect(await f.store.pending(100)).toEqual([f.work])
  expect(f.notifications).toHaveLength(0)
  f.crash(false)
  await f.consumer.apply(f.work)
  await f.consumer.apply(f.work)
  expect(f.state().aggregates.get('all')!.counters.records).toBe('1')
  expect(await f.store.pending(100)).toEqual([])
  expect(f.notifications).toHaveLength(1)
})

test('a source change during allocation rolls back instead of publishing an inconsistent version', async () => {
  const f = fixture()
  f.source([row('record:1', '37')])
  f.unstable()
  await expect(f.consumer.apply(f.work)).rejects.toBeInstanceOf(IncrementalObservationSourceChanged)
  expect(f.state().head.revision).toBe('0')
  expect(f.state().rows.size).toBe(0)
  expect(await f.store.pending(100)).toEqual([f.work])
  expect(f.notifications).toHaveLength(0)
})

test('complete component EOF removes its old tail; enumeration failure retains the full previously committed tail', async () => {
  const f = fixture()
  f.source([row('record:1', '41'), row('record:2', '43')])
  await f.consumer.apply(f.work)
  const before = structuredClone(f.state())
  f.source([row('record:2', '47'), row('record:1', '41')])
  await expect(f.consumer.apply(f.work)).rejects.toThrow('identity or order changed')
  expect(f.state()).toEqual(before)
  f.source([row('record:1', '41')])
  await f.consumer.apply(f.work)
  expect(f.state().rows.size).toBe(1)
  expect(f.state().aggregates.get('all')!.counters.records).toBe('1')
})

test('a component exceeding one thousand rows reaches actual EOF and is never truncated by pending packet size', async () => {
  const f = fixture()
  f.source(
    Array.from({ length: 1007 }, (_, index) =>
      row('record:' + String(index).padStart(6, '0'), String(index + 1)),
    ),
  )
  await f.consumer.apply(f.work)
  expect(f.state().rows.size).toBe(1007)
  expect(f.state().aggregates.get('all')!.counters.records).toBe('1007')
  expect(f.state().aggregates.get('all')!.tokens.input).toBe('507528')
  expect(f.state().aggregates.get('all')!.counters.picos).toBe('124320986535084')
})
