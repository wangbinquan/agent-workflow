// RFC-030 follow-up — locks that /mcps/$name actually mounts
// <McpInventoryPanel/> AND renders it above the edit form.
//
// Why this exists: during the RFC-030 commit dance a concurrent editor
// silently stripped the <McpInventoryPanel mcpName={name} /> insertion
// from routes/mcps.detail.tsx; the page shipped showing only the edit
// form, so the "查看完整接口" link from the /mcps list landed users on a
// page where the inventory looked completely absent. This source-grep
// guards both the import and the JSX mount, and pins the ordering
// (panel before <McpFields/>) so the primary view stays the inventory.

import { readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'src',
  'routes',
  'mcps.detail.tsx',
)

const text = readFileSync(SRC, 'utf-8')

describe('/mcps/$name mounts the RFC-030 inventory panel', () => {
  test('imports McpInventoryPanel from components/mcps/', () => {
    expect(text).toMatch(
      /import\s*\{\s*McpInventoryPanel\s*\}\s*from\s*['"]@\/components\/mcps\/McpInventoryPanel['"]/,
    )
  })

  test('renders the inventory with exact saved hash and save-and-probe callback', () => {
    expect(text).toMatch(/<McpInventoryPanel\s+[\s\S]*?mcpName=\{name\}/)
    expect(text).toContain('operationConfigHash={query.data?.operationConfigHash}')
    expect(text).toContain('onSaveForProbe={saveForProbe}')
  })

  // RFC-169: the inventory panel moved from "stacked above the form" into the
  // detail's "Tools & probe" tab. Both McpFields and McpInventoryPanel are still
  // mounted (keep-mounted tab panels); ordering is now config-tab-first.
  test('mounts both McpFields and the InventoryPanel (keep-mounted tabs)', () => {
    expect(text.indexOf('<McpInventoryPanel')).toBeGreaterThan(0)
    expect(text.indexOf('<McpFields')).toBeGreaterThan(0)
    expect(text).toContain("key: 'probe'")
  })
})
