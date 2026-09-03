// RFC-352 T8 —— 记忆列表分页的纯原语测试。
//
// 为什么这条测试存在：`/api/memories` 的可见性过滤发生在**查询之后**（agent / workflow
// scope 随资源可见性，判定要问 resource-catalog 的 participant），标签过滤也在内存里做
// （tags 是 JSON 列）。因此「先 SQL LIMIT 再过滤」会让每页少行、「先全取再切片」等于没分页。
// `accumulateMemoryPage` 用 keyset 迭代解决这件事，而它的正确性全在游标语义上：
//
//   - 页满 ⇒ 游标取最后一条**返回**的行（该批里排它后面、已扫未纳入的行下一页要重新考虑）；
//   - 批数触顶且页未满 ⇒ 游标取最后一条**扫过**的行（已判不可见的不必重扫）；
//   - 源耗尽 ⇒ nextCursor = null。
//
// 弄反其中任何一条都会漏行或死循环，而这两种症状在集成测试里都很难一眼看出来
// （漏行看着像「权限对」，死循环看着像「慢」）。所以在纯函数层穷尽掉。

import { describe, expect, test } from 'bun:test'

import {
  MEMORY_PAGE_MAX_BATCHES,
  accumulateMemoryPage,
  decodeMemoryPageCursor,
  encodeMemoryPageCursor,
  memoryPageBatchSize,
  type MemoryPageAnchor,
} from '../src/modules/memory/domain/listPagination'

interface Row extends MemoryPageAnchor {
  readonly createdAt: number
  readonly id: string
  readonly visible: boolean
}

/** 生成按 `(createdAt, id)` 降序的行；`visibleEvery` = 每隔几行有一行可见。 */
function rows(count: number, visibleEvery = 1): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    createdAt: 1_000_000 - i,
    id: `m_${String(i).padStart(4, '0')}`,
    visible: i % visibleEvery === 0,
  }))
}

function sourceOf(all: readonly Row[]) {
  let batches = 0
  return {
    get batches() {
      return batches
    },
    fetchBatch: async (after: MemoryPageAnchor | null, size: number) => {
      batches += 1
      const start =
        after === null
          ? 0
          : all.findIndex((r) => r.createdAt === after.createdAt && r.id === after.id) + 1
      return all.slice(start, start + size)
    },
  }
}

const keepVisible = async (batch: readonly Row[]) => batch.filter((r) => r.visible)

describe('RFC-352 T8 — 游标编解码', () => {
  test('往返恒等，且对客户端不透明（不是可读的 id）', () => {
    const anchor = { createdAt: 1_788_000_000_123, id: '01M1J7CCG55B3HXYFB0ZWJ79PV' }
    const cursor = encodeMemoryPageCursor(anchor)
    expect(cursor).not.toContain(anchor.id)
    expect(decodeMemoryPageCursor(cursor)).toEqual(anchor)
  })

  test('id 里含冒号也能正确还原（只按第一个冒号切）', () => {
    const anchor = { createdAt: 12, id: 'a:b:c' }
    expect(decodeMemoryPageCursor(encodeMemoryPageCursor(anchor))).toEqual(anchor)
  })

  test('坏游标返回 null，而不是静默当成「从头开始」', () => {
    // 静默从头开始是最坏的降级：客户端会无限翻第一页，看着像「数据不动」。
    expect(decodeMemoryPageCursor('not-base64!!')).toBeNull()
    expect(decodeMemoryPageCursor(Buffer.from('nocolon').toString('base64url'))).toBeNull()
    expect(decodeMemoryPageCursor(Buffer.from(':m_1').toString('base64url'))).toBeNull()
    expect(decodeMemoryPageCursor(Buffer.from('12:').toString('base64url'))).toBeNull()
    expect(decodeMemoryPageCursor(Buffer.from('abc:m_1').toString('base64url'))).toBeNull()
  })
})

describe('RFC-352 T8 — 累积一页', () => {
  test('全可见：页满且游标指向最后一条返回行', async () => {
    const all = rows(25)
    const src = sourceOf(all)
    const page = await accumulateMemoryPage({
      limit: 10,
      start: null,
      fetchBatch: src.fetchBatch,
      keepVisible,
    })
    expect(page.items.map((r) => r.id)).toEqual(all.slice(0, 10).map((r) => r.id))
    expect(decodeMemoryPageCursor(page.nextCursor!)).toEqual({
      createdAt: all[9]!.createdAt,
      id: all[9]!.id,
    })
  })

  test('逐页翻到底：不重不漏，最后一页 nextCursor 为 null', async () => {
    const all = rows(25)
    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 20; guard += 1) {
      const page: Awaited<ReturnType<typeof accumulateMemoryPage<Row>>> =
        await accumulateMemoryPage<Row>({
          limit: 10,
          start: cursor === null ? null : decodeMemoryPageCursor(cursor),
          fetchBatch: sourceOf(all).fetchBatch,
          keepVisible,
        })
      seen.push(...page.items.map((r) => r.id))
      cursor = page.nextCursor
      if (cursor === null) break
    }
    expect(cursor).toBeNull()
    expect(seen).toEqual(all.map((r) => r.id))
    expect(new Set(seen).size).toBe(seen.length)
  })

  test('稀疏可见：一页要跨多批凑齐，且仍然凑满', async () => {
    // 每 5 行可见 1 行；凑 10 行要扫 50 行 —— 单批放不下，必须跨批累积。
    const all = rows(200, 5)
    const src = sourceOf(all)
    const page = await accumulateMemoryPage({
      limit: 10,
      start: null,
      fetchBatch: src.fetchBatch,
      keepVisible,
    })
    expect(page.items.length).toBe(10)
    expect(page.items.every((r) => r.visible)).toBe(true)
    expect(src.batches).toBeGreaterThan(1)
  })

  test('几乎全不可见：批数触顶后返回不满的一页 + 有效游标，不做无界扫描', async () => {
    // 只有最后一行可见：不封顶就会把整张表扫穿。
    const all = rows(10_000).map((r, i) => ({ ...r, visible: i === 9_999 }))
    const src = sourceOf(all)
    const page = await accumulateMemoryPage({
      limit: 10,
      start: null,
      fetchBatch: src.fetchBatch,
      keepVisible,
    })
    expect(src.batches).toBe(MEMORY_PAGE_MAX_BATCHES)
    expect(page.items.length).toBeLessThan(10)
    expect(page.nextCursor).not.toBeNull()
    // 游标指向最后一条**扫过**的行——已判不可见的不必重扫。
    const scanned = MEMORY_PAGE_MAX_BATCHES * memoryPageBatchSize(10)
    expect(decodeMemoryPageCursor(page.nextCursor!)).toEqual({
      createdAt: all[scanned - 1]!.createdAt,
      id: all[scanned - 1]!.id,
    })
  })

  test('触顶后继续翻能翻到底（游标语义闭合，不会卡住）', async () => {
    const all = rows(10_000).map((r, i) => ({ ...r, visible: i === 9_999 }))
    let cursor: string | null = null
    let found = 0
    for (let guard = 0; guard < 60; guard += 1) {
      const page: Awaited<ReturnType<typeof accumulateMemoryPage<Row>>> =
        await accumulateMemoryPage<Row>({
          limit: 10,
          start: cursor === null ? null : decodeMemoryPageCursor(cursor),
          fetchBatch: sourceOf(all).fetchBatch,
          keepVisible,
        })
      found += page.items.length
      cursor = page.nextCursor
      if (cursor === null) break
    }
    expect(cursor).toBeNull()
    expect(found).toBe(1)
  })

  test('空源：立刻到底，不报错也不留游标', async () => {
    const page = await accumulateMemoryPage({
      limit: 10,
      start: null,
      fetchBatch: sourceOf([]).fetchBatch,
      keepVisible,
    })
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  test('末页不满时 nextCursor 为 null（源耗尽 ≠ 触顶）', async () => {
    const all = rows(13)
    const page2 = await accumulateMemoryPage({
      limit: 10,
      start: { createdAt: all[9]!.createdAt, id: all[9]!.id },
      fetchBatch: sourceOf(all).fetchBatch,
      keepVisible,
    })
    expect(page2.items.map((r) => r.id)).toEqual(all.slice(10).map((r) => r.id))
    expect(page2.nextCursor).toBeNull()
  })

  test('同毫秒的行靠 id 决胜，不会因为 createdAt 相等而漏或重', async () => {
    // 批量蒸馏会在同一毫秒创建多条；只按 createdAt 做游标必然出错。
    const all = Array.from({ length: 12 }, (_, i) => ({
      createdAt: 777,
      id: `m_${String(i).padStart(2, '0')}`,
      visible: true,
    }))
    const first = await accumulateMemoryPage({
      limit: 5,
      start: null,
      fetchBatch: sourceOf(all).fetchBatch,
      keepVisible,
    })
    const second = await accumulateMemoryPage({
      limit: 5,
      start: decodeMemoryPageCursor(first.nextCursor!),
      fetchBatch: sourceOf(all).fetchBatch,
      keepVisible,
    })
    expect(first.items.map((r) => r.id)).toEqual(all.slice(0, 5).map((r) => r.id))
    expect(second.items.map((r) => r.id)).toEqual(all.slice(5, 10).map((r) => r.id))
  })
})
