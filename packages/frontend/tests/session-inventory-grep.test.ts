// RFC-029 T9 grep-locks — keeps SessionTab.tsx wired to
// RuntimeInventorySection AND keeps the section off StatsTab.tsx.
// Also guards the i18n key shape that the section relies on.

import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')
function resolve(...parts: string[]): string {
  return join(SRC, ...parts)
}
// Backwards-compat: tests below call resolve(ROOT, 'a/b/c').
const ROOT = ''

describe('RFC-029 wiring lock', () => {
  test('SessionTab imports RuntimeInventorySection', () => {
    const src = readFileSync(resolve(ROOT, 'components/node-session/SessionTab.tsx'), 'utf-8')
    expect(src).toContain('RuntimeInventorySection')
    // Must appear within the non-fanout-parent branch (i.e. before
    // SessionBody) so the section sits above the conversation flow.
    const idxInv = src.indexOf('<RuntimeInventorySection')
    const idxBody = src.indexOf('<SessionBody')
    expect(idxInv).toBeGreaterThanOrEqual(0)
    expect(idxBody).toBeGreaterThanOrEqual(0)
    expect(idxInv).toBeLessThan(idxBody)
  })

  test('StatsTab DOES NOT import RuntimeInventorySection (Stats is intentionally untouched)', () => {
    const stats = resolve(ROOT, 'components/StatsTab.tsx')
    if (!existsSync(stats)) {
      // Drawer integrates stats inline rather than as a separate tab file.
      const drawer = readFileSync(resolve(ROOT, 'components/NodeDetailDrawer.tsx'), 'utf-8')
      expect(drawer).not.toContain('RuntimeInventorySection')
      return
    }
    const src = readFileSync(stats, 'utf-8')
    expect(src).not.toContain('RuntimeInventorySection')
  })

  // RFC-297: 四张手写表（AgentsTable/SkillsTable/McpsTable/PluginsTable）已退役，
  // 由一张按 driver 表态选列的 InventoryFaceTable 取代——加 `tools` 面时若照抄
  // 第五张，运行时之间的字段差异就会永远散在五个组件里。
  test('section component renders faces through the single generic table', () => {
    const src = readFileSync(
      resolve(ROOT, 'components/inventory/RuntimeInventorySection.tsx'),
      'utf-8',
    )
    expect(src).toContain('InventoryFaceTable')
    // 面集合与列集都由后端带回的 declaration 驱动，前端不认识任何运行时名字。
    expect(src).toContain('declaration')
    expect(src).not.toMatch(/'opencode'|'claude-code'/)
    // RFC-146: the capability gate is the shared agent-kind predicate now
    // (isPromptCapableKind was a local copy of it and is gone).
    expect(src).toContain('isAgentNodeKind')
    expect(src).toContain("'inventory'")
  })

  test('StatusBadge is the single source for MCP status chips (only the generic table imports it)', () => {
    const table = readFileSync(
      resolve(ROOT, 'components/inventory/InventoryFaceTable.tsx'),
      'utf-8',
    )
    expect(table).toContain('StatusBadge')
    const section = readFileSync(
      resolve(ROOT, 'components/inventory/RuntimeInventorySection.tsx'),
      'utf-8',
    )
    expect(section).not.toContain('StatusBadge')
  })
})
