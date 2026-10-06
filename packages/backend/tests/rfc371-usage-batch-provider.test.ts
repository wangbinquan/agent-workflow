// RFC-371: actual SQLite/PG TEMP batches must retain the original allocation EOF and every Token bucket.
import { expect, test } from 'bun:test'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { completeUsageWorkspace } from '@/modules/run-observability/infrastructure/completeUsageWorkspace'
import { selectCompleteUsage } from '@/modules/run-observability/application/completeUsageSelection'
import { completeWorkingTraversal } from '@/modules/run-observability/application/completeWorkingTraversal'
import type { CompleteWorkingRows } from '@/modules/run-observability/ports/completeWorkingRows'
import type { UsageContributionEvidence } from '@/modules/run-observability/domain/usageSelection'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'

const tokens = { input: '1', cacheRead: '3', cacheWrite: '5', output: '7' }
const identity = (row: UsageContributionEvidence) =>
  JSON.stringify([row.sourceId, row.measurement.invocationId, row.measurement.recordId])
function leaf(n: number) {
  return {
    sourceId: 'batch-original',
    measurement: {
      invocationId: 'same-original-group',
      recordId: 'original-' + n,
      model: null,
      scope: {
        root: 'root',
        session: 'leaf-' + n,
        parentSession: 'root',
        ancestors: ['root'],
        turn: 'turn',
        turnIndex: n,
        level: 'self-total',
      },
    },
    contribution: tokens,
    complete: true,
  } satisfies UsageContributionEvidence
}
function measured(rows: CompleteWorkingRows) {
  const points: string[] = [],
    batches: Array<{ namespace: string; keys: number }> = []
  const original: CompleteWorkingRows = {
    ...rows,
    async get<T>(namespace: string, key: string) {
      points.push(namespace)
      return rows.get<T>(namespace, key)
    },
    async getMany<T>(namespace: string, keys: readonly string[]) {
      batches.push({ namespace, keys: keys.length })
      return rows.getMany<T>(namespace, keys)
    },
  }
  return { rows: original, points, batches }
}

describeEachProvider('RFC-371 complete native batch lookup', (harness) => {
  const snapshots = () =>
    originalReportSnapshotSession({
      ...harness.applicationBinding,
      generationId: 'complete-native-batch',
    })
  test('1201 unique self-total sessions use real bulk reads and preserve every original allocation', async () => {
    await snapshots().run(async (snapshot) => {
      const observed = measured(snapshot.workspace)
      const retention = completeUsageWorkspace({
        rows: observed.rows,
        namespace: 'original-batch',
        keyOf: sha256Hex,
        identity,
      })
      for (let first = 0; first < 1201; first += 100)
        await retention.append(
          Array.from({ length: Math.min(100, 1201 - first) }, (_, n) => leaf(first + n)),
        )
      retention.seal('1201')
      const result = await selectCompleteUsage(retention.workspace)
      await retention.flush()
      expect(result.selected).toBe('1201')
      expect(result.excluded).toBe('0')
      expect(result.allSelectedComplete).toBe(true)
      expect(result.tokens).toEqual({
        input: '1201',
        cacheRead: '3603',
        cacheWrite: '6005',
        output: '8407',
      })
      expect(result.unknownBuckets).toEqual({
        input: '0',
        cacheRead: '0',
        cacheWrite: '0',
        output: '0',
      })
      const seen = new Set<string>()
      for await (const row of completeWorkingTraversal<{
        record: UsageContributionEvidence
        contribution: typeof tokens
      }>(snapshot.workspace, retention.allocationsNamespace)) {
        expect(row.document.contribution).toEqual(tokens)
        expect(seen.has(identity(row.document.record))).toBe(false)
        seen.add(identity(row.document.record))
      }
      expect(seen.size).toBe(1201)
      for (let n = 0; n < 1201; n++) expect(seen.has(identity(leaf(n)))).toBe(true)
      expect(
        observed.points.filter((name) => name.endsWith('/ancestry')).length,
      ).toBeLessThanOrEqual(3)
      expect(
        observed.points.filter((name) => name.endsWith('/coverage/roots')).length,
      ).toBeLessThan(1201)
      const ancestry = observed.batches.filter((batch) => batch.namespace.endsWith('/ancestry'))
      expect(ancestry.some((batch) => batch.keys > 1)).toBe(true)
      expect(ancestry.length).toBeLessThanOrEqual(20)
      expect(
        observed.batches.some(
          (batch) => batch.namespace.endsWith('/coverage/roots') && batch.keys > 1,
        ),
      ).toBe(true)
      expect(observed.batches.every((batch) => batch.keys <= 500)).toBe(true)
    })
  }, 60000)

  test('same-batch summaries replace prefetched absence and retain known or unknown provider/model and bucket semantics', async () => {
    await snapshots().run(async (snapshot) => {
      const retention = completeUsageWorkspace({
        rows: snapshot.workspace,
        namespace: 'original-partitions',
        keyOf: sha256Hex,
        identity,
      })
      const root = leaf(0)
      const summary: UsageContributionEvidence = {
        ...root,
        measurement: {
          ...root.measurement,
          model: { id: 'original-model', provider: 'original-provider' },
          scope: {
            ...root.measurement.scope!,
            session: 'root',
            parentSession: null,
            ancestors: [],
            turnIndex: 1,
            level: 'tree-total',
          },
          coveredThroughTurn: 20,
        },
      }
      const child = (
        id: string,
        model: UsageContributionEvidence['measurement']['model'],
      ): UsageContributionEvidence => ({
        ...leaf(2),
        measurement: {
          ...leaf(2).measurement,
          recordId: id,
          model,
          scope: { ...leaf(2).measurement.scope!, level: 'request' },
        },
      })
      const unknown: UsageContributionEvidence = {
        ...leaf(99),
        measurement: { ...leaf(99).measurement, recordId: 'unknown-scope', scope: undefined },
        contribution: { input: null, cacheRead: '0', cacheWrite: '0', output: '0' },
        complete: false,
      }
      await retention.append([
        child('same-model', { id: 'original-model', provider: 'original-provider' }),
        child('other-provider', { id: 'original-model', provider: 'other-provider' }),
        child('other-model', { id: 'other-model', provider: 'original-provider' }),
        child('unknown-provider', { id: 'original-model', provider: null }),
        child('unknown-model', null),
        unknown,
        summary,
      ])
      retention.seal('7')
      await snapshot.workspace.put('original-partitions/coverage/roots', {
        key: sha256Hex('unrelated'),
        document: { tree: 'unrelated', id: null },
      })
      const result = await selectCompleteUsage(retention.workspace)
      await retention.flush()
      expect(result.selected).toBe('4')
      expect(result.excluded).toBe('3')
      expect(result.ambiguousOverlaps).toBe('2')
      expect(result.unavailableSummaries).toBe('0')
      expect(result.allSelectedComplete).toBe(false)
      expect(result.tokens).toEqual({ input: '3', cacheRead: '9', cacheWrite: '15', output: '21' })
      expect(result.unknownBuckets).toEqual({
        input: '1',
        cacheRead: '0',
        cacheWrite: '0',
        output: '0',
      })
      const records: string[] = []
      for await (const row of completeWorkingTraversal<{ record: UsageContributionEvidence }>(
        snapshot.workspace,
        retention.allocationsNamespace,
      ))
        records.push(row.document.record.measurement.recordId)
      expect(records.sort()).toEqual([
        'original-0',
        'other-model',
        'other-provider',
        'unknown-scope',
      ])
    })
  }, 30000)

  test('521 ancestors cross native packets and a later input page cannot hide a conflicting path', async () => {
    const ancestors = Array.from({ length: 521 }, (_, n) => 'original-depth-' + n)
    const deep: UsageContributionEvidence = {
      ...leaf(0),
      measurement: {
        ...leaf(0).measurement,
        scope: {
          ...leaf(0).measurement.scope!,
          root: ancestors[0]!,
          session: 'deep-leaf',
          parentSession: ancestors.at(-1)!,
          ancestors,
        },
      },
    }
    const plain = Array.from({ length: 99 }, (_, n) => ({
      ...leaf(n + 1),
      measurement: { ...leaf(n + 1).measurement, scope: undefined },
    }))
    await snapshots().run(async (snapshot) => {
      const observed = measured(snapshot.workspace)
      const retention = completeUsageWorkspace({
        rows: observed.rows,
        namespace: 'deep-original',
        keyOf: sha256Hex,
        identity,
      })
      await retention.append([deep, ...plain])
      retention.seal('100')
      const result = await selectCompleteUsage(retention.workspace)
      await retention.flush()
      expect(result.selected).toBe('100')
      expect(result.tokens).toEqual({
        input: '100',
        cacheRead: '300',
        cacheWrite: '500',
        output: '700',
      })
      expect(
        observed.batches.some(
          (batch) => batch.namespace.endsWith('/ancestry') && batch.keys === 500,
        ),
      ).toBe(true)
      const seen: string[] = []
      for await (const row of completeWorkingTraversal<{ record: UsageContributionEvidence }>(
        snapshot.workspace,
        retention.allocationsNamespace,
      ))
        seen.push(identity(row.document.record))
      expect(seen.sort()).toEqual([deep, ...plain].map(identity).sort())
    })
    const conflicting: UsageContributionEvidence = {
      ...deep,
      measurement: {
        ...deep.measurement,
        recordId: 'cross-page-conflict',
        scope: {
          ...deep.measurement.scope!,
          ancestors: [...ancestors.slice(0, -1), 'changed-last-ancestor'],
          parentSession: 'changed-last-ancestor',
        },
      },
    }
    await snapshots().run(async (snapshot) => {
      const retention = completeUsageWorkspace({
        rows: snapshot.workspace,
        namespace: 'deep-conflict',
        keyOf: sha256Hex,
        identity,
      })
      await retention.append([deep, ...plain, conflicting])
      retention.seal('101')
      await expect(selectCompleteUsage(retention.workspace)).rejects.toThrow(
        'Conflicting observation session ancestry',
      )
      expect(await snapshot.workspace.page(retention.allocationsNamespace, null, 100)).toEqual({
        items: [],
        nextCursor: null,
      })
    })
  }, 60000)
})
