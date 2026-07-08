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

  test('section component pulls the four sub-tables', () => {
    const src = readFileSync(
      resolve(ROOT, 'components/inventory/RuntimeInventorySection.tsx'),
      'utf-8',
    )
    expect(src).toContain('AgentsTable')
    expect(src).toContain('SkillsTable')
    expect(src).toContain('McpsTable')
    expect(src).toContain('PluginsTable')
    // RFC-146: the capability gate is the shared agent-kind predicate now
    // (isPromptCapableKind was a local copy of it and is gone).
    expect(src).toContain('isAgentNodeKind')
    expect(src).toContain("'inventory'")
  })

  test('StatusBadge is the single source for MCP status chips (only McpsTable imports it)', () => {
    const mcps = readFileSync(resolve(ROOT, 'components/inventory/McpsTable.tsx'), 'utf-8')
    expect(mcps).toContain('StatusBadge')
    const agents = readFileSync(resolve(ROOT, 'components/inventory/AgentsTable.tsx'), 'utf-8')
    const skills = readFileSync(resolve(ROOT, 'components/inventory/SkillsTable.tsx'), 'utf-8')
    const plugins = readFileSync(resolve(ROOT, 'components/inventory/PluginsTable.tsx'), 'utf-8')
    expect(agents).not.toContain('StatusBadge')
    expect(skills).not.toContain('StatusBadge')
    expect(plugins).not.toContain('StatusBadge')
  })
})
