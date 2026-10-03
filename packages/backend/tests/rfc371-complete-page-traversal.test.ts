// RFC-371: locks in real EOF traversal beyond the old 200/1000/10000 populations.
import { describe, expect, test } from 'bun:test'
import { consumeCompleteSource } from '../src/modules/run-observability/application/completePageTraversal'
import type {
  CompletePageWorkspace,
  CompleteSourcePage,
} from '../src/modules/run-observability/ports/completeReport'

function workspace() {
  const cursors = new Set<string>()
  const ids = new Set<number>()
  let sum = 0n
  const port: CompletePageWorkspace<number> = {
    async claimCursor(source, cursor) {
      const key = JSON.stringify([source, cursor])
      if (cursors.has(key)) throw new Error('duplicate cursor')
      cursors.add(key)
    },
    async append(_source, items) {
      for (const id of items) {
        if (ids.has(id)) throw new Error('duplicate identity')
        ids.add(id)
        sum += BigInt(id)
      }
    },
  }
  return { port, sum: () => sum, count: () => ids.size }
}

describe('complete source traversal', () => {
  test.each([201, 1001, 10001, 20001])('reads all %i rows across bounded pages', async (count) => {
    const store = workspace()
    const result = await consumeCompleteSource({
      source: 'original-usage',
      snapshotId: 'frozen',
      workspace: store.port,
      reader: {
        async next(after) {
          const start = after === null ? 0 : Number(after)
          const end = Math.min(count, start + 25)
          return {
            items: Array.from({ length: end - start }, (_, i) => start + i + 1),
            snapshotId: 'frozen',
            nextCursor: end === count ? null : String(end),
          }
        },
      },
    })
    expect(result.rows).toBe(String(count))
    expect(result.eof).toBe(true)
    expect(store.count()).toBe(count)
    expect(store.sum()).toBe((BigInt(count) * BigInt(count + 1)) / 2n)
  })

  test.each([
    [{ items: [1], snapshotId: 'changed', nextCursor: null }],
    [{ items: [], snapshotId: 'frozen', nextCursor: 'next' }],
    [{ items: [1], snapshotId: 'frozen', nextCursor: '' }],
    [
      { items: [1], snapshotId: 'frozen', nextCursor: 'a' },
      { items: [2], snapshotId: 'frozen', nextCursor: 'a' },
    ],
    [
      { items: [1], snapshotId: 'frozen', nextCursor: 'a' },
      { items: [2], snapshotId: 'frozen', nextCursor: 'b' },
      { items: [3], snapshotId: 'frozen', nextCursor: 'a' },
    ],
    [
      { items: [1], snapshotId: 'frozen', nextCursor: 'a' },
      { items: [1], snapshotId: 'frozen', nextCursor: null },
    ],
  ] satisfies CompleteSourcePage<number>[][])(
    'does not produce EOF after malformed or repeated source data %#',
    async (...pages) => {
      let index = 0
      await expect(
        consumeCompleteSource({
          source: 'original-usage',
          snapshotId: 'frozen',
          workspace: workspace().port,
          reader: { next: async () => pages[index++]! },
        }),
      ).rejects.toBeInstanceOf(Error)
    },
  )

  test('an abort cannot seal a partial population as complete', async () => {
    const controller = new AbortController()
    const store = workspace()
    await expect(
      consumeCompleteSource({
        source: 'original-usage',
        snapshotId: 'frozen',
        workspace: store.port,
        signal: controller.signal,
        reader: {
          async next() {
            controller.abort()
            return { items: [1], snapshotId: 'frozen', nextCursor: null }
          },
        },
      }),
    ).rejects.toBeInstanceOf(Error)
    expect(store.count()).toBe(0)
  })
})
