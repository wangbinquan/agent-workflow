// Regression test for the 2026-05-24 follow-up: every row in the workflow
// editor palette sidebar must lead with a kind-icon glyph so the visual
// column is uniform across Agents / Wrappers / IO / Human sections.
// Before the fix, wrapper + IO items had no icon while Human items did;
// agent items used the bare agent name. This test mounts buildPalette with
// the real i18n bundle and asserts each rendered label starts with one of
// the eight expected glyphs.

import { describe, expect, test } from 'vitest'
import i18n, { setLanguage } from '@/i18n'
import { buildPalette } from '@/components/canvas/nodePalette'
import type { Agent } from '@agent-workflow/shared'

const STUB_AGENT: Agent = {
  id: 'a',
  name: 'coder',
  description: 'writes code',
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

const KIND_ICON_GLYPHS = ['⚙', '⎈', '⟳', '⫶', '↳', '⤴', '⚖', '⚡']
const LEADING_ICON_RE = new RegExp(`^(?:${KIND_ICON_GLYPHS.map((g) => g).join('|')}) `)

describe('palette rows lead with a kind-icon glyph (both locales)', () => {
  for (const lang of ['en-US', 'zh-CN'] as const) {
    test(`every palette item label starts with a kind icon — ${lang}`, () => {
      setLanguage(lang)
      try {
        const t = i18n.t.bind(i18n)
        const sections = buildPalette([STUB_AGENT], t)
        for (const section of sections) {
          for (const entry of section.items) {
            expect(
              LEADING_ICON_RE.test(entry.label),
              `[${lang}] palette section "${section.label}" item "${entry.label}" should start with one of ${KIND_ICON_GLYPHS.join(' ')} + space`,
            ).toBe(true)
          }
        }
      } finally {
        setLanguage('en-US')
      }
    })
  }

  test('agent palette items use the ⚙ icon and preserve the agent name', () => {
    setLanguage('en-US')
    const t = i18n.t.bind(i18n)
    const sections = buildPalette([STUB_AGENT], t)
    const agents = sections.find((s) => s.label === 'Agents')
    expect(agents).toBeDefined()
    expect(agents?.items[0]?.label).toBe('⚙ coder')
  })

  test('human-category labels use clean kind names — no "node" suffix or mid-string English in zh-CN', () => {
    setLanguage('zh-CN')
    try {
      const t = i18n.t.bind(i18n)
      const sections = buildPalette([], t)
      const human = sections.find((s) => s.label === '人工')
      expect(human).toBeDefined()
      const labels = human?.items.map((i) => i.label) ?? []
      expect(labels).toContain('⚖ 评审')
      expect(labels).toContain('⚡ 反问')
      expect(labels).toContain('⚡ 跨代理反问')
      // 2026-05-22 regression carrier: the cross-clarify label used to be
      // "⚡ 跨 agent 反问" — mid-string English. Lock it out.
      expect(labels.some((l) => l.includes('agent'))).toBe(false)
      // "评审节点" / "节点" suffix was dropped in 2026-05-24 follow-up.
      expect(labels.some((l) => l.endsWith('节点'))).toBe(false)
    } finally {
      setLanguage('en-US')
    }
  })
})
