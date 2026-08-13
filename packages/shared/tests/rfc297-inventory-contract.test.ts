// RFC-297 T4 —— 统一清单契约的纯函数锁。
//
// 这些用例锁的是「运行时清单」跨运行时统一后最容易悄悄漂移的三件事：
//  1. 来源对账（injected / ambient / declared-missing）的判据；
//  2. 「该面无观测」绝不被投影成「声明的东西没加载」——这是 RFC-280 立下的语义，
//     清单面复用它，两处必须永远给出同一批名字（见 rfc297-missing-parity 一节）；
//  3. 面名 ↔ 平台声明清单键名的映射闭合（agents↔subagents / mcps↔mcpServers 是
//     两处不同形的命名，对错一处的后果是「我注入的」被显示成「运行时自带的」）。

import { describe, expect, test } from 'bun:test'
import {
  INVENTORY_FACES,
  INVENTORY_FACE_TO_DECLARED_KEY,
  InventoryEntrySchema,
  RuntimeInventoryObservationSchema,
  assembleFace,
  faceIsRenderable,
  missingDeclared,
  renderableFields,
  type InventoryDeclaration,
  type ObservedInventoryItem,
} from '../src/schemas/runtimeInventory'

const item = (key: string, extra: Partial<ObservedInventoryItem> = {}): ObservedInventoryItem => ({
  key,
  name: key,
  ...extra,
})

describe('assembleFace —— 来源对账三态', () => {
  test('observed ∩ declared → injected；observed − declared → ambient', () => {
    const entries = assembleFace([item('mine'), item('builtin')], ['mine'])
    expect(entries.map((e) => [e.key, e.provenance])).toEqual([
      ['builtin', 'ambient'],
      ['mine', 'injected'],
    ])
  })

  test('declared − observed → 合成一条 declared-missing', () => {
    const entries = assembleFace([item('loaded')], ['loaded', 'ghost'])
    expect(entries.find((e) => e.key === 'ghost')?.provenance).toBe('declared-missing')
    // 合成条目只有名字，没有富字段——它从未被运行时报告过。
    expect(entries.find((e) => e.key === 'ghost')).toEqual({
      key: 'ghost',
      name: 'ghost',
      provenance: 'declared-missing',
    })
  })

  test('declared === null（该面未被约束，如 tools）→ 全部 ambient 且不产生 missing', () => {
    const entries = assembleFace([item('read'), item('write')], null)
    expect(entries.every((e) => e.provenance === 'ambient')).toBe(true)
    expect(entries).toHaveLength(2)
  })

  test('富字段原样透传，不被对账逻辑改写', () => {
    const [entry] = assembleFace([item('a', { mode: 'subagent', modelId: 'x', hint: null })], ['a'])
    expect(entry).toMatchObject({
      mode: 'subagent',
      modelId: 'x',
      hint: null,
      provenance: 'injected',
    })
  })

  test('输出按 key 字典序稳定排序', () => {
    const entries = assembleFace([item('z'), item('a'), item('m')], [])
    expect(entries.map((e) => e.key)).toEqual(['a', 'm', 'z'])
  })

  test('产出的条目满足 InventoryEntry schema', () => {
    for (const entry of assembleFace([item('a', { status: 'connected' })], ['a', 'b'])) {
      expect(InventoryEntrySchema.safeParse(entry).success).toBe(true)
    }
  })
})

describe('「无观测」不等于「未加载」（RFC-280 语义，清单面复用）', () => {
  test('observed === undefined → 不产出任何条目，尤其不产出 declared-missing', () => {
    expect(assembleFace(undefined, ['injected-but-unobservable'])).toEqual([])
  })

  test('missingDeclared 对 undefined 观测返回空——不能证明它没到场', () => {
    expect(missingDeclared(['a', 'b'], undefined)).toEqual([])
  })

  test('observed 为空数组才是真答案：运行时报告了这一面，且一个都没加载', () => {
    expect(missingDeclared(['a', 'b'], [])).toEqual(['a', 'b'])
    expect(assembleFace([], ['a']).map((e) => e.provenance)).toEqual(['declared-missing'])
  })
})

describe('rfc297-missing-parity —— 与 verifyStartup 判定同源', () => {
  // backend 的 verifyStartup 里 `missing` 就是本函数（RFC-297 T3 单点化）。这条
  // 用例锁的是：清单里被标成 declared-missing 的名字集，与告警 banner 报缺失的
  // 名字集恒等。两者一旦分叉，用户会在同一个抽屉里看到互相矛盾的两句话。
  const cases: Array<{ declared: string[]; observed: string[] | undefined }> = [
    { declared: [], observed: [] },
    { declared: ['a'], observed: [] },
    { declared: ['a', 'b'], observed: ['b'] },
    { declared: ['a'], observed: ['a'] },
    { declared: ['a'], observed: undefined },
    { declared: [], observed: ['ambient'] },
  ]
  for (const { declared, observed } of cases) {
    test(`declared=${JSON.stringify(declared)} observed=${JSON.stringify(observed)}`, () => {
      const fromMissing = missingDeclared(declared, observed).sort()
      const fromEntries = assembleFace(
        observed?.map((k) => item(k)),
        declared,
      )
        .filter((e) => e.provenance === 'declared-missing')
        .map((e) => e.key)
        .sort()
      expect(fromEntries).toEqual(fromMissing)
    })
  }
})

describe('面名 ↔ 声明清单键名映射闭合', () => {
  test('五个面逐一有映射，且无多余键', () => {
    expect(Object.keys(INVENTORY_FACE_TO_DECLARED_KEY).sort()).toEqual([...INVENTORY_FACES].sort())
  })

  test('两处不同形的命名被固定下来', () => {
    expect(INVENTORY_FACE_TO_DECLARED_KEY.agents).toBe('subagents')
    expect(INVENTORY_FACE_TO_DECLARED_KEY.mcps).toBe('mcpServers')
  })
})

describe('declaration 驱动的渲染判据', () => {
  const declaration: InventoryDeclaration = {
    agents: {
      support: 'supported',
      fields: { mode: 'unsupported', model: 'unsupported', source: 'unobservable' },
    },
    skills: {
      support: 'supported',
      fields: { source: 'supported', path: 'supported', description: 'supported' },
    },
    mcps: {
      support: 'supported',
      fields: { status: 'supported', type: 'unsupported', hint: 'unsupported' },
    },
    plugins: { support: 'unsupported', fields: { source: 'unsupported' } },
    tools: { support: 'supported', fields: {} },
  }

  test('unsupported 的面不渲染——「没有这个概念」与「0 个」必须可区分', () => {
    expect(faceIsRenderable(declaration, 'plugins')).toBe(false)
    expect(faceIsRenderable(declaration, 'tools')).toBe(true)
  })

  test('unsupported 的字段不出列；unobservable 仍出列（要能显示「注入了但看不到」）', () => {
    expect(renderableFields(declaration, 'agents')).toEqual(['source'])
    expect(renderableFields(declaration, 'mcps')).toEqual(['status'])
    expect(renderableFields(declaration, 'tools')).toEqual([])
  })
})

describe('观测结果 schema', () => {
  test('captured 四态可解析，not-produced 与 unavailable 分属不同状态', () => {
    const captured = RuntimeInventoryObservationSchema.safeParse({
      state: 'captured',
      capturedAt: 1,
      faces: { skills: [{ key: 'a', name: 'a', provenance: 'injected' }] },
    })
    expect(captured.success).toBe(true)
    expect(
      RuntimeInventoryObservationSchema.safeParse({
        state: 'not-produced',
        reason: 'session-reused',
      }).success,
    ).toBe(true)
    expect(
      RuntimeInventoryObservationSchema.safeParse({ state: 'unavailable', reason: 'no-init-event' })
        .success,
    ).toBe(true)
  })

  test('存量转码标记可选，缺席即正常新行', () => {
    const parsed = RuntimeInventoryObservationSchema.parse({
      state: 'captured',
      capturedAt: 2,
      faces: {},
      provenanceUnavailable: true,
    })
    expect(parsed).toMatchObject({ provenanceUnavailable: true })
  })
})
