// RFC-327 —— 记忆标签纯函数面的语义锁。
//
// 为什么这条测试存在：在此之前「按标签过滤」只有一个单值 `tag` + 内存里
// `tags.includes(needle)`（services/memory.ts），多标签、any/all、facets 计数全都
// 没有可断言的一处。REST 列表路由、facets 路由与 MCP `resource_read` 的 query 透传
// 现在共用这一套；任何一条语义漂移（例如 all 悄悄退化成 any、facets 把同一条记忆
// 的重复标签计两次）必须在这里先红。

import { describe, expect, test } from 'bun:test'
import {
  aggregateTagFacets,
  matchesTagFilter,
  normalizeTagList,
  wantedTags,
} from '../src/memoryTags'

describe('normalizeTagList', () => {
  test('trim、去空、保序去重', () => {
    expect(normalizeTagList([' a ', 'b', 'a', '', '   ', 'c'])).toEqual(['a', 'b', 'c'])
  })
  test('空输入 → 空数组', () => {
    expect(normalizeTagList([])).toEqual([])
  })
})

describe('wantedTags', () => {
  test('legacy 单值 tag 与 tags 合并成一个集合', () => {
    expect(wantedTags({ tag: 'x', tags: ['y', 'x'] })).toEqual(['x', 'y'])
  })
  test('两者都没给 → 空', () => {
    expect(wantedTags({})).toEqual([])
  })
})

describe('matchesTagFilter', () => {
  test('没有想要的标签 ⇒ 恒真（等于不筛）', () => {
    expect(matchesTagFilter([], {})).toBe(true)
    expect(matchesTagFilter(['a'], { tags: [] })).toBe(true)
  })
  test('缺省 any：命中任一即可', () => {
    expect(matchesTagFilter(['a', 'z'], { tags: ['a', 'b'] })).toBe(true)
    expect(matchesTagFilter(['z'], { tags: ['a', 'b'] })).toBe(false)
  })
  test('显式 all：必须全部命中', () => {
    expect(matchesTagFilter(['a', 'b', 'c'], { tags: ['a', 'b'], tagMode: 'all' })).toBe(true)
    expect(matchesTagFilter(['a'], { tags: ['a', 'b'], tagMode: 'all' })).toBe(false)
  })
  test('legacy 单值 tag 仍然精确匹配（向后兼容）', () => {
    expect(matchesTagFilter(['api'], { tag: 'api' })).toBe(true)
    expect(matchesTagFilter(['apix'], { tag: 'api' })).toBe(false)
  })
  test('single tag + tags 在 all 模式下一起判', () => {
    expect(matchesTagFilter(['a', 'b'], { tag: 'a', tags: ['b'], tagMode: 'all' })).toBe(true)
    expect(matchesTagFilter(['a'], { tag: 'a', tags: ['b'], tagMode: 'all' })).toBe(false)
  })
})

describe('aggregateTagFacets', () => {
  test('计数 + count 降序、同数按 tag 升序', () => {
    expect(
      aggregateTagFacets([
        { tags: ['api', 'db'] },
        { tags: ['api'] },
        { tags: ['zzz', 'db'] },
        { tags: [] },
      ]),
    ).toEqual([
      { tag: 'api', count: 2 },
      { tag: 'db', count: 2 },
      { tag: 'zzz', count: 1 },
    ])
  })
  test('同一条记忆里的重复标签只计一次', () => {
    expect(aggregateTagFacets([{ tags: ['a', 'a', 'a'] }])).toEqual([{ tag: 'a', count: 1 }])
  })
  test('空集合 → 空 facets（不是 undefined / 不抛）', () => {
    expect(aggregateTagFacets([])).toEqual([])
  })
})
