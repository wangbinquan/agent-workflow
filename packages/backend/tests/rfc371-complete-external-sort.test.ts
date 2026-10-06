// RFC-034/RFC-371: stable original JS ordering survives spill, multiple merge passes and EOF.
import { describe, expect, test } from 'bun:test'
import { completeExternalSort } from '../src/modules/run-observability/application/completeExternalSort'
import { completeOrdinalKey } from '../src/modules/run-observability/domain/completeOrdinal'
import type {
  CompleteWorkingRows,
  CompleteWorkingRow,
} from '../src/modules/run-observability/ports/completeWorkingRows'
function workingRows() {
  const namespaces = new Map<string, Map<string, unknown>>()
  let largestInsert = 0,
    largestPage = 0
  const rows = (namespace: string) => {
    let value = namespaces.get(namespace)
    if (!value) {
      value = new Map()
      namespaces.set(namespace, value)
    }
    return value
  }
  const workspace: CompleteWorkingRows = {
    async insert(namespace, items) {
      largestInsert = Math.max(largestInsert, items.length)
      const target = rows(namespace),
        keys = new Set<string>()
      for (const row of items) {
        if (target.has(row.key) || keys.has(row.key)) throw new Error('duplicate row')
        keys.add(row.key)
      }
      for (const row of items) target.set(row.key, structuredClone(row.document))
    },
    async upsert(namespace, items) {
      largestInsert = Math.max(largestInsert, items.length)
      for (const row of items) rows(namespace).set(row.key, structuredClone(row.document))
    },
    async put(namespace, row) {
      rows(namespace).set(row.key, structuredClone(row.document))
    },
    async get<T>(namespace: string, key: string) {
      return rows(namespace).get(key) as T | undefined
    },
    async getMany<T>(namespace: string, keys: readonly string[]) {
      const found = new Map<string, T>()
      for (const key of keys)
        if (rows(namespace).has(key)) found.set(key, structuredClone(rows(namespace).get(key)) as T)
      return found
    },
    async page<T>(namespace: string, after: string | null, size = 100) {
      const selected = [...rows(namespace)]
          .filter(([key]) => after === null || key > after)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .slice(0, size + 1),
        items = selected
          .slice(0, size)
          .map(([key, document]) => ({ key, document: structuredClone(document) as T }))
      largestPage = Math.max(largestPage, items.length)
      return { items, nextCursor: selected.length > size ? items.at(-1)!.key : null }
    },
    async clear(namespace) {
      namespaces.delete(namespace)
    },
  }
  return {
    workspace,
    namespaces,
    largestInsert: () => largestInsert,
    largestPage: () => largestPage,
  }
}
async function* sequence<T>(items: readonly T[]) {
  yield* items
}
async function collect<T>(items: AsyncIterable<T>) {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}
describe('complete external merge sorting', () => {
  test('10001 rows retain exact localeCompare order and stable ties through bounded fan-in', async () => {
    const working = workingRows(),
      names = ['任务10', '任务2', 'a', 'A', 'á', 'ä', 'z', 'é', 'e', 'β', '01', '1']
    const input = Array.from({ length: 10001 }, (_, n) => ({
      key: names[(n * 7) % names.length]!,
      ordinal: n,
      token: String(n + 1),
    }))
    const compare = (a: (typeof input)[number], b: (typeof input)[number]) =>
      a.key.localeCompare(b.key)
    const sorted = await completeExternalSort({
      workspace: working.workspace,
      namespace: 'full-original-sort',
      records: sequence(input),
      compare,
      batchSize: 71,
      fanIn: 3,
    })
    expect(sorted.rows).toBe('10001')
    expect(sorted.runs).toBe('141')
    expect(await collect(sorted.records())).toEqual([...input].sort(compare))
    expect(await collect(sorted.records())).toEqual([...input].sort(compare))
    expect(working.largestInsert()).toBeLessThanOrEqual(500)
    expect(working.largestPage()).toBeLessThanOrEqual(100)
    expect(working.namespaces.size).toBe(1)
  })
  test('arbitrary exact ordinal magnitudes order as text without a total-row budget', () => {
    const numbers = [
      0n,
      1n,
      9n,
      10n,
      99n,
      100n,
      9007199254740991n,
      9007199254740992n,
      10n ** 100n,
      10n ** 120n,
    ]
    expect(numbers.map(completeOrdinalKey).sort()).toEqual(numbers.map(completeOrdinalKey))
    expect(() => completeOrdinalKey(-1n)).toThrow()
  })
  test('empty/single populations, invalid batches, interrupted sources and non-progressing workspace pages fail honestly', async () => {
    const working = workingRows(),
      compare = (a: number, b: number) => a - b
    const empty = await completeExternalSort({
      workspace: working.workspace,
      namespace: 'empty',
      records: sequence<number>([]),
      compare,
    })
    expect(empty.rows).toBe('0')
    expect(await collect(empty.records())).toEqual([])
    const single = await completeExternalSort({
      workspace: working.workspace,
      namespace: 'one',
      records: sequence([7]),
      compare,
    })
    expect(await collect(single.records())).toEqual([7])
    for (const patch of [{ batchSize: 0 }, { batchSize: 1001 }, { fanIn: 1 }, { fanIn: 17 }])
      await expect(
        completeExternalSort({
          workspace: working.workspace,
          namespace: 'invalid',
          records: sequence([1]),
          compare,
          ...patch,
        }),
      ).rejects.toThrow('batch')
    const controller = new AbortController()
    const interrupted = async function* () {
      yield 1
      controller.abort(new Error('original interrupted'))
      yield 2
    }
    await expect(
      completeExternalSort({
        workspace: working.workspace,
        namespace: 'abort',
        records: interrupted(),
        compare,
        signal: controller.signal,
      }),
    ).rejects.toThrow('interrupted')
    const broken: CompleteWorkingRows = {
      ...working.workspace,
      page: async <T>() => ({ items: [] as CompleteWorkingRow<T>[], nextCursor: 'did-not-read' }),
    }
    const result = await completeExternalSort({
      workspace: broken,
      namespace: 'bad',
      records: sequence([1]),
      compare,
    })
    await expect(collect(result.records())).rejects.toThrow('advance')
  })
  test('missing tail, middle, duplicate original ordinals and malformed identities cannot become a complete report', async () => {
    for (const corrupt of ['tail', 'middle', 'duplicate', 'invalid'] as const) {
      const working = workingRows(),
        sorted = await completeExternalSort({
          workspace: working.workspace,
          namespace: corrupt,
          records: sequence([0, 1, 2, 3, 4]),
          compare: (a: number, b: number) => a - b,
        })
      const [name, rows] = [...working.namespaces][0]!
      if (corrupt === 'tail') rows.delete(completeOrdinalKey(4n))
      if (corrupt === 'middle') rows.delete(completeOrdinalKey(2n))
      if (corrupt === 'duplicate') rows.set(completeOrdinalKey(4n), { record: 4, ordinal: '3' })
      if (corrupt === 'invalid') rows.set(completeOrdinalKey(4n), { record: 4, ordinal: '04' })
      await expect(collect(sorted.records())).rejects.toThrow()
      expect([...working.namespaces.keys()]).toEqual([name])
    }
  })
})
