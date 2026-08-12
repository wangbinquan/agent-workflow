// RFC-291 面 A/B/F —— 提交入库后的清单迁移纯函数。
//
// 这些用例锁的是用户报的缺陷（「我提交入库的东西我继续改的时候，发现没挂载不让改」）
// 在清单层的正解，以及设计门查出的两条真错：
//
//  · P1-c：copy 谱系若只记**直接来源**，O→C1→C2 之后再从 O 派生 C3，退根只命中
//    C1、漏掉 C2 ⇒ C2 与 C3 同时为根，「只留最新副本」失效。谱系必须取**根**。
//  · P1-d：handle ordinal 会跨轮被回收复用（清单每轮重建 + inventory cap 淘汰），
//    旧对话里的 `res#agent#3` 于是指向另一个资源。高水位必须持久化。
//
// 另有一条**顺序回归锁**：applyCommitMounts 的三步（同源退根 → 原件退根 → 创建物
// 挂根）顺序是有语义的——先挂后退会让最新副本把自己退掉，正好与用户诉求相反。

import { describe, expect, test } from 'bun:test'
import {
  applyCommitMounts,
  createHandleAllocator,
  handleWatermarkOf,
  inheritCopyProvenance,
  lineageRootOf,
  mergeHandleWatermarks,
  parseHandleWatermark,
  type IntentContextManifest,
  type IntentManifestEntry,
} from '../src/services/intent/manifest'

const entry = (
  over: Partial<IntentManifestEntry> & Pick<IntentManifestEntry, 'handle'>,
): IntentManifestEntry => ({
  resourceType: 'agent',
  resourceId: `id-${over.handle}`,
  root: false,
  detail: false,
  ...over,
})

const rootHandles = (m: IntentContextManifest): string[] =>
  m
    .filter((e) => e.root)
    .map((e) => e.handle)
    .sort()

describe('applyCommitMounts — 创建物挂根（AC-1 / AC-5）', () => {
  test('六类资源逐类挂根，且初值 detail:false（未 dump 就没有 fence）', () => {
    const created = (['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup'] as const).map(
      (resourceType) => ({ resourceType, resourceId: `${resourceType}-1` }),
    )

    const next = applyCommitMounts([], { created, unmountHandles: [] })

    expect(next).toHaveLength(6)
    for (const e of next) {
      expect(e.root).toBe(true)
      expect(e.detail).toBe(false)
      expect(e.fence).toBeUndefined()
    }
    expect(next.map((e) => e.handle).sort()).toEqual(
      [
        'res#agent#1',
        'res#mcp#1',
        'res#plugin#1',
        'res#skill#1',
        'res#workflow#1',
        'res#workgroup#1',
      ].sort(),
    )
  })

  test('既有条目复用既有 handle 并置 root，不新增行', () => {
    const before: IntentContextManifest = [
      entry({ handle: 'res#agent#7', resourceId: 'a1', root: false, detail: true }),
    ]
    const next = applyCommitMounts(before, {
      created: [{ resourceType: 'agent', resourceId: 'a1' }],
      unmountHandles: [],
    })
    expect(next).toHaveLength(1)
    expect(next[0]?.handle).toBe('res#agent#7')
    expect(next[0]?.root).toBe(true)
  })

  test('幂等：同一输入重放，结果收敛（AC-4 的函数级面）', () => {
    const input = {
      created: [{ resourceType: 'agent' as const, resourceId: 'a1' }],
      unmountHandles: [],
    }
    const once = applyCommitMounts([], input)
    const twice = applyCommitMounts(once, input)
    expect(twice).toEqual(once)
  })

  test('不改动入参（纯函数）', () => {
    const before: IntentContextManifest = [entry({ handle: 'res#agent#1', resourceId: 'a1' })]
    const snapshot = JSON.parse(JSON.stringify(before)) as IntentContextManifest
    applyCommitMounts(before, {
      created: [{ resourceType: 'agent', resourceId: 'a2' }],
      unmountHandles: ['res#agent#1'],
    })
    expect(before).toEqual(snapshot)
  })
})

describe('applyCommitMounts — copy 退原件（AC-7 / AC-8）', () => {
  test('命中的原件只置 root:false，条目与 handle 保留', () => {
    const before: IntentContextManifest = [
      entry({ handle: 'res#agent#1', resourceId: 'origin', root: true, detail: true }),
    ]
    const next = applyCommitMounts(before, {
      created: [{ resourceType: 'agent', resourceId: 'copy1', copiedFromResourceId: 'origin' }],
      unmountHandles: ['res#agent#1'],
    })
    const origin = next.find((e) => e.resourceId === 'origin')
    expect(origin).toBeDefined()
    expect(origin?.root).toBe(false)
    expect(origin?.handle).toBe('res#agent#1')
    expect(rootHandles(next)).toEqual(['res#agent#2'])
  })

  test('原件本就不是根 / handle 不存在 → 无操作，不抛错（AC-8）', () => {
    const before: IntentContextManifest = [
      entry({ handle: 'res#agent#1', resourceId: 'origin', root: false, detail: true }),
    ]
    const next = applyCommitMounts(before, {
      created: [{ resourceType: 'agent', resourceId: 'copy1', copiedFromResourceId: 'origin' }],
      unmountHandles: ['res#agent#1', 'res#agent#999'],
    })
    expect(next.find((e) => e.resourceId === 'origin')?.root).toBe(false)
    expect(rootHandles(next)).toEqual(['res#agent#2'])
  })
})

describe('applyCommitMounts — 只留最新副本（AC-8b，设计门 P1-c）', () => {
  test('谱系取根：O→C1→C2 后再从 O 派生 C3，C1 与 C2 都退根', () => {
    // C2 的直接来源是 C1，但它的谱系根是 O —— 只比直接来源就会漏掉 C2。
    const before: IntentContextManifest = [
      entry({ handle: 'res#agent#1', resourceId: 'O', root: false, detail: true }),
      entry({ handle: 'res#agent#2', resourceId: 'C1', root: false, copiedFromResourceId: 'O' }),
      entry({ handle: 'res#agent#3', resourceId: 'C2', root: true, copiedFromResourceId: 'O' }),
    ]
    const next = applyCommitMounts(before, {
      created: [{ resourceType: 'agent', resourceId: 'C3', copiedFromResourceId: 'O' }],
      unmountHandles: ['res#agent#1'],
    })

    expect(next.find((e) => e.resourceId === 'C1')?.root).toBe(false)
    expect(next.find((e) => e.resourceId === 'C2')?.root).toBe(false)
    expect(next.find((e) => e.resourceId === 'C3')?.root).toBe(true)
    // 唯一的同源根就是最新副本
    expect(rootHandles(next)).toEqual(['res#agent#4'])
    // 退根不回收 handle：历史引用仍可解析
    expect(next.find((e) => e.resourceId === 'C2')?.handle).toBe('res#agent#3')
  })

  test('顺序回归锁：最新副本不会被同源规则把自己退掉', () => {
    // 若实现把「创建物挂根」放在「同源退根」之前，新副本（带同一 copiedFrom）
    // 会被自己的规则命中 ⇒ root:false，与用户诉求正好相反。
    const next = applyCommitMounts([], {
      created: [{ resourceType: 'agent', resourceId: 'C1', copiedFromResourceId: 'O' }],
      unmountHandles: [],
    })
    expect(next.find((e) => e.resourceId === 'C1')?.root).toBe(true)
  })

  test('同一批次里对同一原件派生两个副本 → 两个都是根（同批不互退）', () => {
    // 同批多副本不是「更新换代」，没有先后语义，不应互相退根。
    const next = applyCommitMounts([], {
      created: [
        { resourceType: 'agent', resourceId: 'C1', copiedFromResourceId: 'O' },
        { resourceType: 'agent', resourceId: 'C2', copiedFromResourceId: 'O' },
      ],
      unmountHandles: [],
    })
    expect(rootHandles(next)).toEqual(['res#agent#1', 'res#agent#2'])
  })

  test('不同谱系互不牵连', () => {
    const before: IntentContextManifest = [
      entry({ handle: 'res#agent#1', resourceId: 'CA', root: true, copiedFromResourceId: 'OA' }),
    ]
    const next = applyCommitMounts(before, {
      created: [{ resourceType: 'agent', resourceId: 'CB', copiedFromResourceId: 'OB' }],
      unmountHandles: [],
    })
    expect(next.find((e) => e.resourceId === 'CA')?.root).toBe(true)
  })

  test('跨类型同名 resourceId 不互退（比较键含 resourceType）', () => {
    const before: IntentContextManifest = [
      entry({
        handle: 'res#skill#1',
        resourceType: 'skill',
        resourceId: 'CS',
        root: true,
        copiedFromResourceId: 'shared-origin-id',
      }),
    ]
    const next = applyCommitMounts(before, {
      created: [
        { resourceType: 'agent', resourceId: 'CA', copiedFromResourceId: 'shared-origin-id' },
      ],
      unmountHandles: [],
    })
    expect(next.find((e) => e.resourceId === 'CS')?.root).toBe(true)
  })

  test('旧清单没有 copiedFromResourceId（RFC-291 之前）→ 只卸原件，不误伤（F5b）', () => {
    const before: IntentContextManifest = [
      entry({ handle: 'res#agent#1', resourceId: 'O', root: true, detail: true }),
      entry({ handle: 'res#agent#2', resourceId: 'legacy-copy', root: true }),
    ]
    const next = applyCommitMounts(before, {
      created: [{ resourceType: 'agent', resourceId: 'C1', copiedFromResourceId: 'O' }],
      unmountHandles: ['res#agent#1'],
    })
    expect(next.find((e) => e.resourceId === 'legacy-copy')?.root).toBe(true)
    expect(next.find((e) => e.resourceId === 'O')?.root).toBe(false)
  })
})

describe('lineageRootOf', () => {
  test('副本取谱系根，非副本取自身', () => {
    expect(lineageRootOf({ resourceId: 'C1', copiedFromResourceId: 'O' })).toBe('O')
    expect(lineageRootOf({ resourceId: 'O' })).toBe('O')
  })
})

describe('inheritCopyProvenance — 跨轮承继（AC-8b 的持久面）', () => {
  test('dump 重建后的条目补回谱系字段', () => {
    const prior: IntentContextManifest = [
      entry({ handle: 'res#agent#2', resourceId: 'C1', copiedFromResourceId: 'O' }),
    ]
    // 重建产物不带谱系（三条构造路径都不知道 copy 这回事）
    const rebuilt: IntentContextManifest = [
      entry({ handle: 'res#agent#2', resourceId: 'C1', root: true, detail: true }),
    ]
    const next = inheritCopyProvenance(rebuilt, prior)
    expect(next[0]?.copiedFromResourceId).toBe('O')
  })

  test('新条目自带谱系时不被旧值覆盖', () => {
    const prior: IntentContextManifest = [
      entry({ handle: 'res#agent#2', resourceId: 'C1', copiedFromResourceId: 'OLD' }),
    ]
    const rebuilt: IntentContextManifest = [
      entry({ handle: 'res#agent#2', resourceId: 'C1', copiedFromResourceId: 'NEW' }),
    ]
    expect(inheritCopyProvenance(rebuilt, prior)[0]?.copiedFromResourceId).toBe('NEW')
  })

  test('无旧清单 / 旧清单无谱系 → 原样返回', () => {
    const rebuilt: IntentContextManifest = [entry({ handle: 'res#agent#1', resourceId: 'a1' })]
    expect(inheritCopyProvenance(rebuilt, undefined)[0]?.copiedFromResourceId).toBeUndefined()
    expect(inheritCopyProvenance(rebuilt, [])[0]?.copiedFromResourceId).toBeUndefined()
  })
})

describe('handle 高水位（AC-20 / AC-21，设计门 P1-d）', () => {
  test('清单丢失条目后，高水位仍阻止 ordinal 复用', () => {
    // 复现路径：res#agent#3 曾被分配 → 该条目被 cap 淘汰 / 资源被删 → 清单里只剩
    // res#agent#1。没有高水位时下一个新资源会拿到 #2、#3，与历史对话冲突。
    const survived: IntentContextManifest = [entry({ handle: 'res#agent#1', resourceId: 'a1' })]
    const watermark = { agent: 3 }

    const withoutWatermark = createHandleAllocator(survived)
    expect(withoutWatermark.next.agent).toBe(1)

    const withWatermark = createHandleAllocator(survived, watermark)
    expect(withWatermark.next.agent).toBe(3)

    const next = applyCommitMounts(survived, {
      created: [{ resourceType: 'agent', resourceId: 'fresh' }],
      unmountHandles: [],
    })
    // applyCommitMounts 只看清单 ⇒ 会给出 #2；真正的防线是调用方把高水位
    // 一起写回（applyChangeset / turnEngine / session 三处），下面的 merge 覆盖。
    expect(next.find((e) => e.resourceId === 'fresh')?.handle).toBe('res#agent#2')
    const merged = mergeHandleWatermarks(watermark, handleWatermarkOf(createHandleAllocator(next)))
    expect(merged.agent).toBe(3)
  })

  test('mergeHandleWatermarks 取 max，单调不回退', () => {
    expect(mergeHandleWatermarks({ agent: 5 }, { agent: 2, skill: 1 })).toEqual({
      agent: 5,
      skill: 1,
    })
    expect(mergeHandleWatermarks(undefined, { agent: 2 })).toEqual({ agent: 2 })
    expect(mergeHandleWatermarks({ agent: 2 }, undefined)).toEqual({ agent: 2 })
  })

  test('handleWatermarkOf 反映已分配的最大 ordinal', () => {
    const alloc = createHandleAllocator([
      entry({ handle: 'res#agent#4', resourceId: 'a4' }),
      entry({ handle: 'res#skill#2', resourceType: 'skill', resourceId: 's2' }),
    ])
    expect(handleWatermarkOf(alloc)).toEqual({ agent: 4, skill: 2 })
  })

  test('parseHandleWatermark 容错：空 / 非法 / 损坏都退化为 {}（AC-21）', () => {
    expect(parseHandleWatermark(null)).toEqual({})
    expect(parseHandleWatermark('')).toEqual({})
    expect(parseHandleWatermark('{}')).toEqual({})
    expect(parseHandleWatermark('not json')).toEqual({})
    expect(parseHandleWatermark('[1,2]')).toEqual({})
    expect(parseHandleWatermark('{"agent":"x","skill":3}')).toEqual({ skill: 3 })
    expect(parseHandleWatermark('{"agent":-1}')).toEqual({})
  })
})
