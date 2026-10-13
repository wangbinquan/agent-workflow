// RFC-371: qualification leaves the original reservation before any durable
// writer is acquired. The private spool retains all rows through a verified EOF.
import { expect, test } from 'bun:test'
import { incrementalObservationPreparationSpool } from '@/modules/run-observability/infrastructure/incrementalObservationPreparationSpool'
import { emptyCompleteObservationFold } from '@/modules/run-observability/domain/completeObservationMetrics'
import type { QualifiedObservationContribution } from '@/modules/run-observability/ports/incrementalObservationQualified'
import { opencodeConnectedSessions } from '@/modules/runtime-management/infrastructure/opencodeConnectedSessions'
import { persistentNativeFixture } from './helpers/rfc371PersistentNativeFactFixture'

test('all 1007 qualified rows, unicode labels and exact values survive the snapshot handoff', async () => {
  const controller = new AbortController(),
    spool = incrementalObservationPreparationSpool(controller.signal)
  const work = { id: 'spool-fixture', source: 'original', revision: '1', components: ['scope'] }
  const rows: QualifiedObservationContribution[] = Array.from({ length: 1007 }, (_, n) => ({
    key: String(n),
    component: 'scope',
    aggregates: ['cohort'],
    fold: {
      ...emptyCompleteObservationFold(),
      tokens: { input: '9007199254740997', cacheRead: '7', cacheWrite: '11', output: '13' },
    },
    detail: {
      section: 'cohort-fold',
      parent: null,
      key: String(n),
      taskId: null,
      cohortAt: n,
      document: { label: '实现 Agent ' + n },
    },
  }))
  try {
    for (let at = 0; at < rows.length; at += 150) spool.append(work, rows.slice(at, at + 150))
    spool.seal(
      work,
      { generation: 'original', snapshotId: 'snapshot', baseRevision: '0', asOf: 1234 },
      work.components,
    )
    const observed = []
    for await (const row of spool.rows()) observed.push(row)
    expect(observed).toEqual(rows)
    expect(observed.at(-1)?.fold.tokens.input).toBe('9007199254740997')
    expect(() => spool.append(work, rows.slice(0, 1))).toThrow('closed')
  } finally {
    spool.close()
  }
})
test('aborting after source EOF stops handoff before a consumer can finish', async () => {
  const controller = new AbortController(),
    spool = incrementalObservationPreparationSpool(controller.signal)
  try {
    spool.seal(
      { id: 'empty', source: 'source', revision: '1', components: [] },
      { generation: 'original', snapshotId: 'snapshot', baseRevision: '0', asOf: 1 },
      [],
    )
    controller.abort(new Error('original handoff stopped'))
    await expect(
      (async () => {
        for await (const _row of spool.rows()) throw new Error('unexpected row')
      })(),
    ).rejects.toThrow()
  } finally {
    spool.close()
  }
})
test('physical parent and all descendants are discovered without an application parent event or a usage read', async () => {
  const original = persistentNativeFixture({ steps: 2, depth: 4 })
  try {
    const expected = ['root', 'child-0', 'child-1', 'child-2', 'child-3'].sort()
    expect(opencodeConnectedSessions(original.path, ['child-2'])).toEqual(expected)
    expect(opencodeConnectedSessions(original.path, ['root', 'root'])).toEqual(expected)
    expect(opencodeConnectedSessions(original.path, ['unrelated'])).toEqual(['unrelated'])
    expect(opencodeConnectedSessions(original.path + '.missing', ['root'])).toBeNull()
  } finally {
    await original.close()
  }
})
