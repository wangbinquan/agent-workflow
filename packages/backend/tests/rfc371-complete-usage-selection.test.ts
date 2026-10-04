// RFC-371: differential oracle for exact native coverage, including a single huge root.
import { describe, expect, test } from 'bun:test'
import {
  compareCompleteUsage,
  selectCompleteUsage,
} from '../src/modules/run-observability/application/completeUsageSelection'
import {
  coveragePrefixMaximum,
  insertCoverageInterval,
  type CoverageIntervalNode,
  type CoverageIntervalStore,
} from '../src/modules/run-observability/domain/coverageIntervalIndex'
import {
  selectUsageContributions,
  type UsageContributionEvidence,
} from '../src/modules/run-observability/domain/usageSelection'
import type { TokenUsage } from '../src/modules/run-observability/domain/tokenUsage'

function intervalStore() {
  const roots = new Map<string, string>()
  const nodes = new Map<string, CoverageIntervalNode>()
  let sequence = 0n,
    reads = 0
  const store: CoverageIntervalStore = {
    async root(tree) {
      return roots.get(tree) ?? null
    },
    async setRoot(tree, id) {
      roots.set(tree, id)
    },
    async node(tree, id) {
      reads++
      const node = nodes.get(JSON.stringify([tree, id]))
      if (!node) throw new Error('missing interval')
      return node
    },
    async save(tree, node) {
      nodes.set(JSON.stringify([tree, node.id]), { ...node })
    },
    async allocateId() {
      return String(++sequence)
    },
  }
  return { store, reads: () => reads, nodes }
}

function record(
  id: string,
  patch: Partial<UsageContributionEvidence> = {},
): UsageContributionEvidence {
  return {
    sourceId: 'native-original',
    measurement: {
      invocationId: 'invocation',
      recordId: id,
      model: { provider: 'one', id: 'model' },
      scope: {
        root: 'root',
        session: 'root',
        parentSession: null,
        ancestors: [],
        turn: id,
        turnIndex: 1,
        level: 'self-total',
      },
      coveredThroughTurn: 1,
    },
    contribution: { input: '10', cacheRead: '2', cacheWrite: '3', output: '4' },
    complete: true,
    ...patch,
  }
}

async function indexed(
  records: UsageContributionEvidence[],
  issue?: (
    value: UsageContributionEvidence,
    quality: {
      readonly ambiguous: boolean
      readonly unavailable: boolean
      readonly allocated: boolean
    },
  ) => Promise<void>,
) {
  const index = intervalStore(),
    paths = new Map<string, string>(),
    allocated: Array<{ record: UsageContributionEvidence; contribution: TokenUsage }> = []
  const output = await selectCompleteUsage(
    {
      coverage: index.store,
      async *records() {
        yield* records
      },
      async *orderedRecords() {
        yield* [...records].sort(compareCompleteUsage)
      },
      async bindAncestry(group, session, ancestors) {
        const key = JSON.stringify([group, session]),
          path = JSON.stringify(ancestors)
        if (paths.has(key) && paths.get(key) !== path)
          throw new Error('Conflicting observation session ancestry')
        paths.set(key, path)
      },
      async allocate(record, contribution) {
        allocated.push({ record, contribution })
      },
    },
    undefined,
    issue,
  )
  return { output, allocated, reads: index.reads() }
}

const allocations = (
  rows: Array<{ record: UsageContributionEvidence; contribution: TokenUsage }>,
) =>
  rows
    .map(
      ({ record: r, contribution }) =>
        [
          JSON.stringify([r.sourceId, r.measurement.invocationId, r.measurement.recordId]),
          contribution,
        ] as const,
    )
    .sort(([a], [b]) => a.localeCompare(b))

async function compareOracle(rows: UsageContributionEvidence[]) {
  const old = selectUsageContributions(rows),
    next = await indexed(rows)
  expect(allocations(next.allocated)).toEqual(
    allocations(old.records.map((r) => ({ record: r, contribution: r.contribution }))),
  )
  expect(next.output.excluded).toBe(String(old.excluded))
  expect(next.output.ambiguousOverlaps).toBe(String(old.ambiguousOverlaps))
  expect(next.output.unavailableSummaries).toBe(String(old.unavailableSummaries))
  expect(next.output.tokens).toEqual(old.summary.known)
  expect(next.output.unknownBuckets).toEqual(
    Object.fromEntries(
      Object.entries(old.summary.unknownBuckets).map(([bucket, count]) => [bucket, String(count)]),
    ),
  )
  expect(next.output.allSelectedComplete).toBe(
    old.allSelectedComplete &&
      Object.values(old.summary.unknownBuckets).every((count) => count === 0),
  )
}

describe('persistent exact coverage selection', () => {
  test('the original ordered pass awaits each all-bucket overlap issue and ignores fully covered duplicates', async () => {
    const first = record('first', {
      measurement: { ...record('first').measurement, coveredThroughTurn: 2 },
    })
    const second = record('second', {
      measurement: {
        ...record('second').measurement,
        coveredThroughTurn: 3,
        scope: { ...record('second').measurement.scope!, turnIndex: 2 },
      },
    })
    const issues: Array<{ recordId: string; allocated: boolean; ambiguous: boolean }> = []
    const value = await indexed([second, first], async (original, quality) => {
      await Promise.resolve()
      issues.push({
        recordId: original.measurement.recordId,
        allocated: quality.allocated,
        ambiguous: quality.ambiguous,
      })
    })
    expect(issues).toEqual([{ recordId: 'second', allocated: false, ambiguous: true }])
    expect(value.output.selected).toBe('1')
    expect(value.output.excluded).toBe('1')
    expect(value.output.ambiguousOverlaps).toBe('1')
    expect(value.output.allSelectedComplete).toBe(false)
    await expect(
      indexed([first, second], async () => {
        throw new Error('original quality owner failed')
      }),
    ).rejects.toThrow('original quality owner failed')
    const covered = record('covered', {
      measurement: {
        ...first.measurement,
        recordId: 'covered',
        scope: { ...first.measurement.scope!, level: 'request' },
      },
    })
    const deduplicated = await indexed([covered, first], async () => {
      throw new Error('fully covered duplicate is not a quality issue')
    })
    expect(deduplicated.output.selected).toBe('1')
    expect(deduplicated.output.excluded).toBe('1')
    expect(deduplicated.output.ambiguousOverlaps).toBe('0')
    expect(deduplicated.output.allSelectedComplete).toBe(true)
  })
  test('keeps original selected-count rejection and covered-count exclusion semantics', async () => {
    for (const invalid of ['-1', '01', '0x10', '', '1.0', '1e3', '9'.repeat(61)]) {
      for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
        const value = record('invalid', {
          contribution: {
            input: '0',
            cacheRead: '0',
            cacheWrite: '0',
            output: '0',
            [bucket]: invalid,
          },
          measurement: { ...record('invalid').measurement, scope: undefined },
        })
        expect(() => selectUsageContributions([value])).toThrow('Token count')
        await expect(indexed([value])).rejects.toThrow('Token count')
      }
      const summary = record('summary'),
        covered = record('covered', {
          measurement: {
            ...summary.measurement,
            recordId: 'covered',
            scope: { ...summary.measurement.scope!, level: 'request' },
          },
          contribution: {
            input: invalid,
            cacheRead: invalid,
            cacheWrite: invalid,
            output: invalid,
          },
        })
      await compareOracle([summary, covered])
    }
    await compareOracle([
      record('null-zero-large', {
        contribution: {
          input: null,
          cacheRead: '0',
          cacheWrite: '9007199254740993',
          output: '9'.repeat(60),
        },
      }),
    ])
  })

  test('four independent ends, null providers and excluded partial summaries retain original semantics', async () => {
    const a = record('é-summary', {
      coveredThrough: { input: 4, cacheRead: 1, cacheWrite: 2, output: 3 },
    })
    const b = record('partially-excluded', {
      measurement: {
        ...a.measurement,
        recordId: 'partially-excluded',
        coveredThroughTurn: 5,
        scope: { ...a.measurement.scope!, turnIndex: 2 },
      },
    })
    const c = record('child', {
      measurement: {
        ...a.measurement,
        recordId: 'child',
        model: { id: 'model', provider: null },
        coveredThroughTurn: 4,
        scope: {
          ...a.measurement.scope!,
          session: 'child',
          parentSession: 'root',
          ancestors: ['root'],
          turnIndex: 4,
          level: 'request',
        },
      },
    })
    const d = record('wildcard', {
      measurement: {
        ...a.measurement,
        recordId: 'wildcard',
        model: null,
        coveredThroughTurn: 3,
        scope: { ...a.measurement.scope!, level: 'tree-total' },
      },
      contribution: { input: null, cacheRead: '8', cacheWrite: '9', output: '10' },
    })
    await compareOracle([c, b, a, d])
  })

  test('two adjacent summaries never become one covering interval', async () => {
    const a = record('a', { measurement: { ...record('a').measurement, coveredThroughTurn: 2 } })
    const b = record('b', {
      measurement: {
        ...a.measurement,
        recordId: 'b',
        coveredThroughTurn: 4,
        scope: { ...a.measurement.scope!, turnIndex: 3 },
      },
    })
    const request = record('request', {
      measurement: {
        ...a.measurement,
        recordId: 'request',
        coveredThroughTurn: 4,
        scope: { ...a.measurement.scope!, level: 'request' },
      },
    })
    await compareOracle([request, b, a])
    expect((await indexed([a, b, request])).output.ambiguousOverlaps).toBe('1')
  })

  test('seeded differential cases cover model/provider/root/depth/turn/bucket combinations', async () => {
    let seed = 712371
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % n
    }
    const models = [
      null,
      { provider: 'one', id: 'same' },
      { provider: 'two', id: 'same' },
      { provider: null, id: 'same' },
      { provider: 'one', id: 'other' },
    ]
    for (let trial = 0; trial < 24; trial++) {
      const rows = Array.from({ length: 96 }, (_, i) => {
        const root = `root-${random(3)}`,
          depth = random(3),
          session = depth ? `${root}-child-${depth}` : root
        const turnIndex = random(9) + 1,
          through = turnIndex + random(5)
        const buckets = ['input', 'cacheRead', 'cacheWrite', 'output'] as const
        const contribution = Object.fromEntries(
          buckets.map((bucket) => [bucket, random(8) === 0 ? null : String(random(100))]),
        ) as unknown as TokenUsage
        return record(`é-${trial}-${i}`, {
          contribution,
          complete: random(7) !== 0,
          measurement: {
            invocationId: `invocation-${random(2)}`,
            recordId: `é-${trial}-${i}`,
            model: models[random(models.length)]!,
            coveredThroughTurn: through,
            scope: {
              root,
              session,
              parentSession: depth ? root : null,
              ancestors: depth ? [root] : [],
              turn: `turn-${turnIndex}`,
              turnIndex,
              level: (['tree-total', 'self-total', 'request'] as const)[random(3)]!,
            },
          },
          coveredThrough: Object.fromEntries(
            buckets.map((bucket) => [bucket, turnIndex + random(5)]),
          ) as unknown as Record<(typeof buckets)[number], number>,
        })
      })
      await compareOracle(rows)
    }
  })

  test('ancestry conflicts fail before any derived allocation', async () => {
    const a = record('a'),
      b = record('b', {
        measurement: {
          ...a.measurement,
          recordId: 'b',
          scope: {
            ...a.measurement.scope!,
            session: 'root',
            ancestors: ['root'],
            parentSession: 'root',
          },
        },
      })
    await expect(indexed([a, b])).rejects.toThrow('Cyclic')
  })

  test('10001 disjoint intervals in one tree stay logarithmic and preserve exact single-interval maxima', async () => {
    const index = intervalStore(),
      count = 10001
    for (let i = 0; i < count; i++)
      await insertCoverageInterval(index.store, 'one-root', { start: i * 2, end: i * 2 + 1 })
    expect(await coveragePrefixMaximum(index.store, 'one-root', -1)).toBeNull()
    expect(await coveragePrefixMaximum(index.store, 'one-root', 1234)).toBe(1235)
    expect(await coveragePrefixMaximum(index.store, 'one-root', count * 2)).toBe(count * 2 - 1)
    const head = await index.store.root('one-root'),
      root = await index.store.node('one-root', head!)
    expect(root.height).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(count + 1)))
    expect(index.reads()).toBeLessThan(count * 130)
    expect(index.nodes.size).toBe(count)
  }, 30_000)
})
