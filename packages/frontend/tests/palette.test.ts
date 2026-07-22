// Coverage for the drag-create palette (P-2-05).
//
// makeNode is the integration point with the canvas: dragged item +
// drop position → new WorkflowNode with kind-appropriate defaults.
// serialize/deserialize round-trip checks the dataTransfer wire format.

import { describe, expect, test } from 'vitest'
import type { Agent } from '@agent-workflow/shared'
import { NODE_KIND } from '@agent-workflow/shared'
import {
  PALETTE_DESCRIPTORS,
  PALETTE_SECTIONS,
  buildPalette,
  deserialize,
  makeNode,
  serialize,
  type PaletteItem,
} from '../src/components/canvas/nodePalette'

const AGENT_A: Agent = {
  id: 'a',
  name: 'coder',
  description: '',
  outputs: ['code'],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: '',
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
}

describe('serialize/deserialize', () => {
  test('agent-single round-trips with name', () => {
    const raw = serialize({ kind: 'agent-single', agentName: 'coder' })
    expect(deserialize(raw)).toEqual({ kind: 'agent-single', agentName: 'coder' })
  })

  // RFC-060 PR-E: agent-multi removed from the palette. deserialize now
  // returns null for the legacy serialized form so old workflow.yaml imports
  // surface as "unknown kind" instead of silently re-introducing it.
  test('agent-multi (legacy) deserializes to null', () => {
    expect(deserialize(JSON.stringify({ kind: 'agent-multi' }))).toBeNull()
    expect(deserialize(JSON.stringify({ kind: 'agent-multi', agentName: 'x' }))).toBeNull()
  })

  test('wrapper / io kinds round-trip without extra fields', () => {
    for (const kind of ['input', 'output', 'wrapper-git', 'wrapper-loop'] as const) {
      const raw = serialize({ kind } as PaletteItem)
      expect(deserialize(raw)).toEqual({ kind })
    }
  })

  test('unknown kind / garbage → null', () => {
    expect(deserialize('not json')).toBeNull()
    expect(deserialize(JSON.stringify({ kind: 'magic' }))).toBeNull()
    // RFC-146 impl-gate（Codex medium）：dataTransfer 载荷不可信，继承键
    // （原型链上 'constructor' in TABLE === true）不得当 kind 放行——旧
    // switch 天然拒绝，表驱动后靠 Object.hasOwn 守门。
    expect(deserialize(JSON.stringify({ kind: 'constructor' }))).toBeNull()
    expect(deserialize(JSON.stringify({ kind: 'toString' }))).toBeNull()
    expect(deserialize(JSON.stringify({ kind: '__proto__' }))).toBeNull()
    expect(deserialize(JSON.stringify({ random: 'shape' }))).toBeNull()
  })
})

describe('makeNode', () => {
  test('agent-single carries agentName + integer position', () => {
    const n = makeNode(
      { kind: 'agent-single', agentName: 'coder' },
      { x: 12.4, y: 5.6 },
      { existingIds: new Set() },
    )
    expect(n.kind).toBe('agent-single')
    expect((n as Record<string, unknown>).agentName).toBe('coder')
    expect(n.position).toEqual({ x: 12, y: 6 })
    expect(n.id.startsWith('agent_')).toBe(true)
  })

  // RFC-060 PR-E: agent-multi removed from the palette; the prior fan_ id
  // prefix is no longer minted. Users drop a wrapper-fanout (wrap_fan prefix)
  // instead.

  test('input node gets unique requirement key', () => {
    const n = makeNode({ kind: 'input' }, { x: 0, y: 0 }, { existingIds: new Set() })
    expect(n.kind).toBe('input')
    expect((n as Record<string, unknown>).inputKey).toBe('requirement')
  })

  test('output node starts with empty ports list', () => {
    const n = makeNode({ kind: 'output' }, { x: 0, y: 0 }, { existingIds: new Set() })
    expect((n as Record<string, unknown>).ports).toEqual([])
  })

  test('wrapper-loop seeds maxIterations=3 + exitCondition=port-empty', () => {
    const n = makeNode({ kind: 'wrapper-loop' }, { x: 0, y: 0 }, { existingIds: new Set() })
    const rec = n as Record<string, unknown>
    expect(rec.maxIterations).toBe(3)
    expect(rec.exitCondition).toEqual({ kind: 'port-empty' })
    expect(rec.nodeIds).toEqual([])
  })

  test('wrapper-git seeds empty nodeIds', () => {
    const n = makeNode({ kind: 'wrapper-git' }, { x: 0, y: 0 }, { existingIds: new Set() })
    expect((n as Record<string, unknown>).nodeIds).toEqual([])
  })

  test('id collision is resolved with -2 suffix', () => {
    // Force the collision branch by pre-claiming the prefix's full namespace
    // via a fake set that pretends every candidate is taken once. The
    // implementation falls through to `${candidate}-${i}` suffixes.
    const claimed = new Set<string>()
    const existing = {
      has(v: string): boolean {
        if (claimed.size === 0 && v.startsWith('agent_')) {
          claimed.add(v)
          return true
        }
        return claimed.has(v)
      },
    } as Set<string>
    const n = makeNode(
      { kind: 'agent-single', agentName: 'coder' },
      { x: 0, y: 0 },
      { existingIds: existing },
    )
    expect(n.id).toMatch(/-2$/)
  })
})

describe('buildPalette', () => {
  // Identity stub stands in for react-i18next's `t` so the assertion can
  // pin the exact i18n keys this module emits without booting the bundle.
  const identityT = (key: string) => key

  test('groups agents into Agents + Wrappers + IO + Human sections (RFC-060 PR-E dropped Fan-out)', () => {
    const sections = buildPalette([AGENT_A], identityT)
    expect(sections.map((s) => s.key)).toEqual(['agents', 'wrappers', 'io', 'human'])
    const labels = sections.map((s) => s.label)
    expect(labels).toEqual([
      'editor.paletteAgents',
      'editor.paletteWrappers',
      'editor.paletteIo',
      'editor.paletteHuman',
    ])
    expect(sections[0]?.items[0]?.item).toEqual({ kind: 'agent-single', agentName: 'coder' })
  })

  test('every NodeKind belongs to exactly one declared RFC-219 category', () => {
    const declaredSections = new Set(PALETTE_SECTIONS.map((section) => section.key))
    expect(NODE_KIND.map((kind) => PALETTE_DESCRIPTORS[kind].section)).toHaveLength(
      NODE_KIND.length,
    )
    for (const kind of NODE_KIND) {
      expect(declaredSections.has(PALETTE_DESCRIPTORS[kind].section)).toBe(true)
    }
  })

  test('always includes wrapper + IO entries regardless of agents', () => {
    const sections = buildPalette([], identityT)
    const all = sections.flatMap((s) => s.items.map((i) => i.item.kind))
    expect(all).toContain('wrapper-git')
    expect(all).toContain('wrapper-loop')
    expect(all).toContain('input')
    expect(all).toContain('output')
  })
})
