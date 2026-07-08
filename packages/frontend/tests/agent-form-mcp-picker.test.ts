// RFC-028 T10 — locks the AgentForm + Stats tab wiring at source level:
//   - AgentForm imports McpsPicker
//   - AgentForm renders an `agentForm.fieldMcps` Field next to the Skills one
//   - Both i18n bundles cover the AgentForm-side MCP picker keys
//
// Regression note: the original RFC-028 also placed a "MCP closure" row in the
// task-detail Stats tab via NodeMcpClosureSection. That row was removed at
// product request — it duplicated information already covered by the
// dependency tree's MCP badges. Tests below lock in the removal so a future
// refactor doesn't bring the chip back.

import { readFileSync, existsSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const TEST_DIR = path.dirname(new URL(import.meta.url).pathname)
const FRONTEND_SRC = resolve(TEST_DIR, '..', 'src')
const read = (rel: string): string => readFileSync(resolve(FRONTEND_SRC, rel), 'utf-8')

describe('RFC-028 T10 — AgentForm MCP picker', () => {
  test('AgentForm.tsx imports McpsPicker and renders the Field', () => {
    const src = read('components/AgentForm.tsx')
    expect(src).toContain("import { McpsPicker } from './McpsPicker'")
    expect(src).toContain('agentForm.fieldMcps')
    // Ensures the new picker hangs off value.mcp (not skills) — otherwise
    // saves would silently lose the user's selection.
    expect(src).toContain("patch('mcp', v)")
  })

  test('McpsPicker.tsx uses the /api/mcps endpoint via TanStack query', () => {
    // RFC-151 PR-2: the query itself moved into the shared <ResourcePicker>;
    // the wrapper pins the cache key + endpoint config. Same intent as the
    // original lock — saves must keep reading real /api/mcps rows.
    const src = read('components/McpsPicker.tsx')
    expect(src).toContain('queryKey={MCPS_QUERY_KEY}')
    expect(src).toContain('endpoint="/api/mcps"')
    const shared = read('components/ResourcePicker.tsx')
    expect(shared).toContain('useQuery')
    expect(shared).toContain('api.get(props.endpoint')
  })
})

describe('Stats tab MCP closure — removed', () => {
  // Locks in the product decision to drop the MCP closure chip from the
  // task-detail workflow tab's agent-node stats. Any reintroduction of the
  // NodeMcpClosureSection import, the statMcpClosure label, or the source
  // file itself should fail here and force a fresh product review.

  test('NodeDetailDrawer no longer imports or renders NodeMcpClosureSection', () => {
    const src = read('components/NodeDetailDrawer.tsx')
    expect(src).not.toContain('NodeMcpClosureSection')
    expect(src).not.toContain('statMcpClosure')
  })

  test('NodeMcpClosureSection source file is deleted', () => {
    expect(existsSync(resolve(FRONTEND_SRC, 'components/agents/NodeMcpClosureSection.tsx'))).toBe(
      false,
    )
  })

  test('i18n bundles no longer carry the MCP-closure stat keys', () => {
    const zh = read('i18n/zh-CN.ts')
    const en = read('i18n/en-US.ts')
    for (const key of ['statMcpClosure', 'mcpClosureEmpty', 'mcpClosureLoadFailed']) {
      expect(zh).not.toContain(key)
      expect(en).not.toContain(key)
    }
  })
})

describe('RFC-028 T10 — AgentForm i18n parity', () => {
  test('zh-CN + en-US both define the AgentForm MCP picker keys', () => {
    const zh = read('i18n/zh-CN.ts')
    const en = read('i18n/en-US.ts')
    for (const key of [
      'fieldMcps:',
      'fieldMcpsHint:',
      'fieldMcpsPlaceholder:',
      'mcpsPickerLabel:',
      'mcpsPickerLoading:',
      'mcpsPickerEmpty:',
      'mcpsPickerLoadFailed:',
    ]) {
      expect(zh).toContain(key)
      expect(en).toContain(key)
    }
  })
})
