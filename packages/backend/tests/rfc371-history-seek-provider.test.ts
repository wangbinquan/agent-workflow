// A published history page must seek its section, while preserving every row and its original MVCC version.
import { expect, test } from 'bun:test'
import { describeEachProvider } from './helpers/eachProvider'
import {
  observationProjectionHistory as history,
  observationProjectionDescriptors as descriptors,
  observationProjectionVersions as versions,
  observationProjectionIndexedVersions as indexed,
} from '@/db/observationProjection'
import { createIncrementalObservationQueryStore } from '@/modules/run-observability/infrastructure/incrementalObservationQueryStore'
import { qualifiedObservationIndexes } from '@/modules/run-observability/domain/qualifiedObservationIndexes'
import { emptyCompleteObservationFold } from '@/modules/run-observability/domain/completeObservationMetrics'
import { emptyIncrementalObservationFold } from '@/modules/run-observability/domain/incrementalObservationFold'

describeEachProvider('RFC-371 exact historical section seeks', (h) => {
  test('both section and parent pages cross EOF without visiting the unrelated section or mixing retained versions', async () => {
    await h.db
      .insert(versions)
      .values([
        { revision: '1', asOf: 1, bootstrapComplete: true },
        { revision: '10', asOf: 10, bootstrapComplete: true },
      ])
      .run()
    await h.db
      .insert(indexed)
      .values([{ revision: '1' }, { revision: '10' }])
      .run()
    const expected: string[] = []
    for (let offset = 0; offset < 1212; offset += 100) {
      const page = Array.from({ length: Math.min(100, 1212 - offset) }, (_, i) => {
        const n = offset + i,
          section = n < 211 ? ('agents' as const) : ('cohort-fold' as const)
        const original = qualifiedObservationIndexes({
          key: 'original-' + n,
          component: 'component-' + n,
          aggregates: [],
          fold: emptyCompleteObservationFold(),
          detail: {
            section,
            parent: null,
            key: 'original-' + n,
            taskId: 'task-' + n,
            cohortAt: n,
            document: { label: 'Original ' + n },
          },
        })
        const key = original.aggregates.find((value) => value.startsWith('qualified-group/'))!
        if (n < 211) expected.push(key)
        return {
          key,
          component: original.component,
          section: 'qualified-group/' + section,
          taskId: 'task-' + n,
          descriptor: original.descriptors![key],
        }
      })
      await h.db
        .insert(descriptors)
        .values(page.map((row) => ({ key: row.key, document: row.descriptor })))
        .run()
      await h.db
        .insert(history)
        .values(
          page.flatMap((row) => {
            const make = (revision: string, input: string, toRevision: string | null) => ({
              kind: 'aggregate' as const,
              key: row.key,
              component: row.component,
              section: row.section,
              parent: null,
              taskId: row.taskId,
              fromRevision: revision,
              toRevision,
              document: JSON.stringify({
                ...emptyIncrementalObservationFold(),
                tokens: { input, cacheRead: '3', cacheWrite: '5', output: '7' },
                counters: { tasks: '1', attempts: '0', numericRecords: '1', nativeCaptures: '0' },
              }),
            })
            return [make('1', '11', '10'), make('10', '17', null)]
          }),
        )
        .run()
    }
    for (const [revision, parent, indexName, count] of [
      ['1', undefined, 'observation_projection_history_section_seek', '11'],
      ['10', null, 'observation_projection_history_parent_seek', '17'],
    ] as const) {
      const recording = h.recordStatements(),
        actual: Array<{ key: string; input: string }> = []
      try {
        for await (const row of createIncrementalObservationQueryStore(h.db).groupedDetails({
          version: { revision, asOf: Number(revision) },
          section: 'agents',
          ...(parent === undefined ? {} : { parent }),
        }))
          actual.push({ key: row.key, input: row.fold.tokens.input })
      } finally {
        recording.stop()
      }
      expect(actual.map((row) => row.key)).toEqual([...expected].sort())
      expect(actual).toHaveLength(211)
      expect(actual.every((row) => row.input === count)).toBe(true)
      const pages = recording
        .selects()
        .filter(
          (row) =>
            row.sql.includes('observation_projection_history') &&
            row.sql.includes('observation_projection_descriptors'),
        )
      expect(pages.map((page) => page.rows)).toEqual([200, 11, 0])
      if (h.capabilities.isolation === 'exclusive')
        for (const page of pages) {
          const plan = await h.explain(page)
          expect(plan).toContain(indexName)
          expect(plan).toMatch(/kind=\? AND section=\?/)
        }
    }
  }, 30000)
})
