// RFC-219 regression lock: a large Agent catalog must not bury Wrapper / I/O /
// Human nodes in one flattened list. The pure model locks category counts,
// grouped search, recent compatibility, and non-duplicated result counts.

import { describe, expect, test } from 'vitest'
import type { Agent } from '@agent-workflow/shared'
import { buildPalette } from '../src/components/canvas/nodePalette'
import {
  deriveNodePickerCatalog,
  workflowNodePickerIdentity,
} from '../src/lib/workflow-node-picker'

const t = (key: string) => key
const labels = { recommended: 'recommended', recent: 'recent' }

function agent(index: number, description = `Capability ${index}`): Agent {
  return {
    id: `agent-${index}`,
    name: `agent-${String(index).padStart(2, '0')}`,
    description,
    outputs: ['out'],
  } as Agent
}

describe('deriveNodePickerCatalog — RFC-219 categories', () => {
  test('keeps stable counts and restores canonical sections with 50 Agents', () => {
    const model = deriveNodePickerCatalog({
      sections: buildPalette(
        Array.from({ length: 50 }, (_, index) => agent(index)),
        t,
      ),
      activeCategory: 'all',
      query: '',
      recentIdentities: [],
      labels,
    })

    expect(model.categoryCounts).toEqual({
      // RFC-269 显式改判：新增 code-host-call ⇒ 全量 61 → 62、新增 integrations 分区。
      all: 62,
      // RFC-304 —— `internal` 恒为 0，而且必须恒为 0：它装的是平台合成、用户永不可
      // 授权的 kind（当前只有 `code-round`），`buildPalette` 根本不为它产出 section。
      // 这个 0 因此不是「暂时没有」而是不变量——它一旦变成非 0，说明某个合成专用
      // 节点漏进了拖拽面板，`all` 也会跟着虚高。
      internal: 0,
      agents: 50,
      wrappers: 3,
      // RFC-243 — call-workflow + call-workgroup entries in the Calls category.
      calls: 2,
      // RFC-253 — the single generic script entry.
      scripts: 1,
      integrations: 1,
      io: 2,
      human: 3,
    })
    expect(model.groups.map((group) => group.key)).toEqual([
      'recommended',
      'agents',
      'wrappers',
      'calls',
      'scripts',
      // RFC-269 显式改判：新增 integrations 分区。
      'integrations',
      'io',
      'human',
    ])
    // RFC-269 显式改判：新增 code-host-call ⇒ 61 → 62。
    expect(model.visibleEntryCount).toBe(62)
  })

  test('opens Wrapper and Human directly without any Agent rows', () => {
    const sections = buildPalette(
      Array.from({ length: 50 }, (_, index) => agent(index)),
      t,
    )
    const wrappers = deriveNodePickerCatalog({
      sections,
      activeCategory: 'wrappers',
      query: '',
      recentIdentities: [],
      labels,
    })
    const human = deriveNodePickerCatalog({
      sections,
      activeCategory: 'human',
      query: '',
      recentIdentities: [],
      labels,
    })

    expect(wrappers.groups.map((group) => group.key)).toEqual(['wrappers'])
    expect(wrappers.groups[0]?.entries.map((entry) => entry.item.kind)).toEqual([
      'wrapper-git',
      'wrapper-loop',
      'wrapper-fanout',
    ])
    expect(human.groups.map((group) => group.key)).toEqual(['human'])
    expect(human.groups[0]?.entries.every((entry) => entry.sectionKey === 'human')).toBe(true)
  })

  test('composes category and query while preserving canonical group labels', () => {
    const sections = buildPalette(
      [agent(1, 'Writes release notes'), agent(2, 'Audits security boundaries')],
      t,
    )
    const agents = deriveNodePickerCatalog({
      sections,
      activeCategory: 'agents',
      query: 'security',
      recentIdentities: [],
      labels,
    })
    const wrappers = deriveNodePickerCatalog({
      sections,
      activeCategory: 'wrappers',
      query: 'security',
      recentIdentities: [],
      labels,
    })

    expect(agents.groups).toHaveLength(1)
    expect(agents.groups[0]?.key).toBe('agents')
    expect(agents.groups[0]?.entries.map((entry) => entry.item)).toEqual([
      // RFC-223 (PR-2): buildPalette now carries the canonical agentId.
      { kind: 'agent-single', agentName: 'agent-02', agentId: 'agent-2' },
    ])
    expect(wrappers.groups).toEqual([])
    expect(wrappers.visibleEntryCount).toBe(0)
  })

  test('keeps recent identities compatible, drops stale entries, and does not double-count rows', () => {
    const sections = buildPalette([agent(1)], t)
    const review = sections
      .flatMap((section) => section.items)
      .find((entry) => entry.item.kind === 'review')
    expect(review).toBeDefined()

    const model = deriveNodePickerCatalog({
      sections,
      activeCategory: 'all',
      query: '',
      recentIdentities: [
        'agent:missing',
        workflowNodePickerIdentity({ kind: 'review' }),
        'agent:agent-1',
      ],
      labels,
    })

    expect(
      model.groups.find((group) => group.key === 'recent')?.entries.map((entry) => entry.identity),
    ).toEqual(['kind:review', 'agent:agent-1'])
    expect(model.visibleEntryCount).toBe(model.categoryCounts.all)
    expect(model.groups.flatMap((group) => group.entries).length).toBeGreaterThan(
      model.visibleEntryCount,
    )
  })

  test('same-name agents keep separate id identities and both restore from recent', () => {
    const left = {
      ...agent(1),
      id: 'agent-owner-a',
      name: 'reviewer',
      ownerUserId: 'owner-a',
    }
    const right = {
      ...agent(2),
      id: 'agent-owner-b',
      name: 'reviewer',
      ownerUserId: 'owner-b',
    }
    const model = deriveNodePickerCatalog({
      sections: buildPalette([left, right], t),
      activeCategory: 'all',
      query: '',
      recentIdentities: ['agent:agent-owner-b', 'agent:agent-owner-a'],
      labels,
    })

    const agentEntries = model.groups.find((group) => group.key === 'agents')?.entries ?? []
    expect(agentEntries.map((entry) => entry.identity)).toEqual([
      'agent:agent-owner-a',
      'agent:agent-owner-b',
    ])
    expect(
      model.groups.find((group) => group.key === 'recent')?.entries.map((entry) => entry.item),
    ).toEqual([
      { kind: 'agent-single', agentName: 'reviewer', agentId: 'agent-owner-b' },
      { kind: 'agent-single', agentName: 'reviewer', agentId: 'agent-owner-a' },
    ])
  })

  test('keeps the zero-Agent category selectable as an empty result', () => {
    const model = deriveNodePickerCatalog({
      sections: buildPalette([], t),
      activeCategory: 'agents',
      query: '',
      recentIdentities: [],
      labels,
    })

    expect(model.categoryCounts.agents).toBe(0)
    // RFC-253 added the Scripts entry ⇒ 10 → 11 non-agent palette rows.
    // RFC-269 显式改判：11 → 12（新增 code-host-call）。
    expect(model.categoryCounts.all).toBe(12)
    expect(model.groups).toEqual([])
    expect(model.visibleEntryCount).toBe(0)
  })
})
