// Regression: one changed component must not scan every retained contribution.
// The merge allocator still receives the complete, globally key-sorted stream.
import { expect, test } from 'bun:test'
import { describeEachProvider } from './helpers/eachProvider'
import {
  observationProjectionCurrent as current,
  observationProjectionWork as work,
  observationProjectionWorkComponents as components,
} from '@/db/observationProjection'
import { createIncrementalObservationProjectionStore } from '@/modules/run-observability/infrastructure/incrementalObservationProjectionStore'
import { emptyCompleteObservationFold } from '@/modules/run-observability/domain/completeObservationMetrics'
import { emptyIncrementalObservationFold } from '@/modules/run-observability/domain/incrementalObservationFold'

describeEachProvider('RFC-371 indexed incremental lookups', (h) => {
  test('changed components cross both page boundaries without scanning unrelated population or changing order', async () => {
    const selected = Array.from(
        { length: 211 },
        (_, n) => 'component-' + String(n).padStart(4, '0'),
      ),
      item = { id: 'lookup-work', source: 'original', revision: '1', components: selected }
    await h.db
      .insert(work)
      .values({ id: item.id, document: JSON.stringify(item), fingerprint: 'original' })
      .run()
    for (let at = 0; at < selected.length; at += 100)
      await h.db
        .insert(components)
        .values(selected.slice(at, at + 100).map((component) => ({ workId: item.id, component })))
        .run()
    const expected: string[] = []
    for (let at = 0; at < 1822; at += 100) {
      const rows = Array.from({ length: Math.min(100, 1822 - at) }, (_, index) => {
        const n = at + index,
          key = 'row-' + String(9999 - n).padStart(5, '0'),
          component = n < 211 ? selected[n]! : n < 621 ? selected[0]! : 'unrelated'
        if (component !== 'unrelated') expected.push(key)
        const document = {
          key,
          component,
          fold: emptyCompleteObservationFold(),
          aggregates: [],
          detail: {},
        }
        return {
          kind: 'contribution' as const,
          key,
          component,
          revision: '1',
          document: JSON.stringify(document),
        }
      })
      await h.db.insert(current).values(rows).run()
    }
    const recording = h.recordStatements(),
      store = createIncrementalObservationProjectionStore(h.db, 'original').store
    let actual: string[] = []
    try {
      actual = await store.change(async (tx) => {
        const keys: string[] = []
        for await (const row of tx.previous(item)) keys.push(row.key)
        return keys
      })
    } finally {
      recording.stop()
    }
    expect(actual).toEqual(expected.sort())
    expect(actual).toHaveLength(621)
    const reads = recording
      .selects()
      .filter((s) => s.sql.includes('observation_projection_current'))
    expect(reads).toHaveLength(5)
    expect(reads.reduce((sum, r) => sum + r.rows, 0)).toBe(621)
    for (const read of reads) {
      if (h.capabilities.isolation === 'exclusive') {
        const plan = await h.explain(read)
        expect(plan).toContain('observation_projection_current_component')
        expect(plan).toMatch(/kind=\? AND component=\?/)
      }
    }
  }, 30000)

  test('publishing a task change seeks that task metadata through the task index', async () => {
    const store = createIncrementalObservationProjectionStore(h.db, 'original').store,
      recording = h.recordStatements()
    try {
      await store.change(async (tx) => {
        const head = await tx.head(),
          version = { revision: String(BigInt(head.revision) + 1n), asOf: 1 }
        await tx.putAggregate('task/exact-owner', emptyIncrementalObservationFold(), version)
        await tx.publish(version)
      })
    } finally {
      recording.stop()
    }
    const reads = recording
      .selects()
      .filter(
        (s) =>
          s.sql.includes('observation_projection_current') &&
          s.sql.includes('"section"') &&
          s.sql.includes('"task_id"'),
      )
    expect(reads).toHaveLength(1)
    if (h.capabilities.isolation === 'exclusive') {
      const plan = await h.explain(reads[0]!)
      expect(plan).toContain('observation_projection_current_task')
      expect(plan).toMatch(/kind=\? AND section=\? AND task_id=\?/)
    }
  })
})
