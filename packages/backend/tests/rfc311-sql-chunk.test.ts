// RFC-311 实现门(测试有效性)——`chunkedAll` 此前零测试,而它有 5 个调用点
// (review / taskAuthorization / lifecycleInvariants / clarify·rounds /
// workgroup·room)。边界(恰好等于块大小、空数组、非整除余数、顺序保持)全裸奔。

import { describe, expect, test } from 'bun:test'

import { SQL_IN_CHUNK, chunkedAll } from '../src/util/sqlChunk'

describe('chunkedAll', () => {
  test('empty input never calls the executor', async () => {
    let calls = 0
    const out = await chunkedAll([], async (chunk) => {
      calls += 1
      return chunk
    })
    expect(out).toEqual([])
    expect(calls).toBe(0)
  })

  test('a single chunk is passed through as one call', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i)
    const sizes: number[] = []
    const out = await chunkedAll(items, async (chunk) => {
      sizes.push(chunk.length)
      return chunk
    })
    expect(sizes).toEqual([10])
    expect(out).toEqual(items)
  })

  test('exactly one chunk-size stays one call (off-by-one boundary)', async () => {
    const items = Array.from({ length: 4 }, (_, i) => i)
    const sizes: number[] = []
    await chunkedAll(
      items,
      async (chunk) => {
        sizes.push(chunk.length)
        return chunk
      },
      4,
    )
    expect(sizes).toEqual([4])
  })

  test('splits past the boundary, keeps order, and never exceeds the chunk size', async () => {
    const items = Array.from({ length: 11 }, (_, i) => i)
    const sizes: number[] = []
    const out = await chunkedAll(
      items,
      async (chunk) => {
        sizes.push(chunk.length)
        return chunk.map((v) => v * 2)
      },
      4,
    )
    expect(sizes).toEqual([4, 4, 3])
    expect(out).toEqual(items.map((v) => v * 2))
  })

  test('the default chunk size stays far below any SQLite variable limit', async () => {
    expect(SQL_IN_CHUNK).toBeLessThanOrEqual(900)
    const items = Array.from({ length: SQL_IN_CHUNK * 2 + 1 }, (_, i) => i)
    const sizes: number[] = []
    await chunkedAll(items, async (chunk) => {
      sizes.push(chunk.length)
      return []
    })
    expect(sizes).toEqual([SQL_IN_CHUNK, SQL_IN_CHUNK, 1])
  })

  test('the executor never sees the caller array itself (mutation safety)', async () => {
    const items = [1, 2, 3]
    await chunkedAll(items, async (chunk) => {
      chunk.push(999)
      return []
    })
    expect(items).toEqual([1, 2, 3])
  })
})
