// RFC-028 T9 — source-code wiring locks for the /mcps {list,new,detail} routes.
//
// We don't render the full TanStack-Router component tree here (the i18next /
// react-query stack would need a full harness); instead we assert the wiring
// from text patterns. This catches:
//   - sidebar nav loses the /mcps entry (regression to pre-RFC-028)
//   - list page stops linking to /mcps/new or /mcps/$id
//   - any of the three routes silently grows a `cwd` input
//   - i18n bundles drift apart for the mcps section
//   - new + detail pages stop using the shared <McpFields> widget (would
//     mean the form drifts between create / edit visually)

import { readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const TEST_DIR = path.dirname(new URL(import.meta.url).pathname)
const FRONTEND_SRC = resolve(TEST_DIR, '..', 'src')

function read(rel: string): string {
  return readFileSync(resolve(FRONTEND_SRC, rel), 'utf-8')
}

describe('RFC-028 /mcps wiring', () => {
  test('sidebar nav exposes a /mcps entry', () => {
    // RFC-032 moved the sidebar nav table from `__root.tsx` into the shared
    // `lib/nav.ts::NAV_GROUPS` constant. The /mcps entry still has to exist;
    // it just lives under the agents group now.
    const nav = read('lib/nav.ts')
    expect(nav).toContain("to: '/mcps'")
  })

  test('router registers list + new + detail routes (literal before $param)', () => {
    // RFC-169: /mcps is a split layout route; new / detail / index are nested
    // children via addChildren (the import now also pulls in IndexRoute).
    const router = read('router.tsx')
    expect(router).toContain("Route as mcpsRoute } from '@/routes/mcps'")
    expect(router).toContain("import { Route as mcpDetailRoute } from '@/routes/mcps.detail'")
    expect(router).toContain("import { Route as mcpNewRoute } from '@/routes/mcps.new'")
    // mcpNewRoute must come before mcpDetailRoute in the addChildren array,
    // otherwise /mcps/new gets eaten by the $id catch-all.
    const newIdx = router.indexOf('mcpNewRoute,')
    const detailIdx = router.indexOf('mcpDetailRoute,')
    expect(newIdx).toBeGreaterThan(0)
    expect(detailIdx).toBeGreaterThan(newIdx)
  })

  test('list page links to /mcps/new and /mcps/$id (split cards, no inline editor box)', () => {
    const page = read('routes/mcps.tsx')
    // Shared split-page create destination + card destinations.
    expect(page).toContain('newTo="/mcps/new"')
    expect(page).toContain("to: '/mcps/$id'")
    // Old inline editor box is gone — page no longer renders McpEditor /
    // mcp-editor class names.
    expect(page).not.toContain('mcp-editor')
    expect(page).not.toContain('McpEditor')
  })

  test('new + detail pages share the McpFields widget (visual parity)', () => {
    const create = read('routes/mcps.new.tsx')
    const edit = read('routes/mcps.detail.tsx')
    expect(create).toContain("import { McpFields } from '@/components/McpFields'")
    expect(edit).toContain("import { McpFields } from '@/components/McpFields'")
    // Both use the same primary-button pattern as agents.new / skills.new:
    // `btn btn--primary` + no Cancel button beside it. RFC-151 PR-4: on the
    // edit page the primary Save renders via the shared <DetailHeaderActions>
    // header cluster.
    expect(create).toContain('btn btn--primary')
    expect(create).not.toMatch(/btn btn--sm[^"]*">[^<]*[Cc]ancel/)
    expect(edit).toContain('DetailHeaderActions')
    expect(read('components/DetailHeaderActions.tsx')).toContain('btn btn--primary')
  })

  test('no route file references the obsolete `cwd` field', () => {
    for (const rel of [
      'routes/mcps.tsx',
      'routes/mcps.new.tsx',
      'routes/mcps.detail.tsx',
      'components/McpFields.tsx',
      'lib/mcp-form.ts',
    ]) {
      const src = read(rel)
      // Allow the word in comments / i18n key names (`cwdHint`), reject only
      // object-literal entries (`cwd:`) and JSX props (`cwd=`).
      expect(/\bcwd:|\bcwd=|\bdata-testid="mcp-field-cwd"/.test(src)).toBe(false)
    }
  })

  test('zh-CN and en-US bundles both define the mcps section', () => {
    const zh = read('i18n/zh-CN.ts')
    const en = read('i18n/en-US.ts')
    for (const key of [
      'title',
      'newButton',
      'newTitle',
      'emptyList',
      'typeLocal',
      'typeRemote',
      'fieldCommand',
      'fieldUrl',
      'createButton',
      'saveButton',
      'toolNamingHint',
      'cwdHint',
      'oauthCliHint',
    ]) {
      expect(zh).toContain(`${key}:`)
      expect(en).toContain(`${key}:`)
    }
    expect(zh).toContain("mcps: 'MCP'")
    expect(en).toContain("mcps: 'MCPs'")
  })
})
