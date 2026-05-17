// RFC-031 T11 — source-code wiring locks for the /plugins {list,new,detail}
// routes. Same shape as RFC-028's mcps-page-wiring test, intentionally
// mirroring the agent / skill / mcp three-route pattern.
//
// We don't render the full router component tree here (the i18next /
// react-query stack needs a full harness); instead we assert wiring from
// text patterns. This catches:
//   - sidebar nav loses the /plugins entry (regression to pre-RFC-031)
//   - list page stops linking to /plugins/new or /plugins/$id
//   - any of the three routes accidentally embeds the inline-editor again
//     (RFC-031 first cut had it; we explicitly migrated to separate routes
//     for parity with /agents and /mcps — a fresh inline editor here would
//     be a regression).
//   - i18n bundles drift apart for the plugins section.

import { readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const TEST_DIR = path.dirname(new URL(import.meta.url).pathname)
const FRONTEND_SRC = resolve(TEST_DIR, '..', 'src')

function read(rel: string): string {
  return readFileSync(resolve(FRONTEND_SRC, rel), 'utf-8')
}

describe('RFC-031 /plugins wiring', () => {
  test('sidebar nav exposes a /plugins entry', () => {
    const root = read('routes/__root.tsx')
    expect(root).toContain("{ to: '/plugins', key: 'plugins' }")
  })

  test('router registers list + new + detail routes (literal before $param)', () => {
    const router = read('router.tsx')
    expect(router).toContain("import { Route as pluginsRoute } from '@/routes/plugins'")
    expect(router).toContain("import { Route as pluginDetailRoute } from '@/routes/plugins.detail'")
    expect(router).toContain("import { Route as pluginNewRoute } from '@/routes/plugins.new'")
    // pluginNewRoute must precede pluginDetailRoute so /plugins/new is not
    // swallowed by the $id catch-all.
    const newIdx = router.indexOf('pluginNewRoute,')
    const detailIdx = router.indexOf('pluginDetailRoute,')
    expect(newIdx).toBeGreaterThan(0)
    expect(detailIdx).toBeGreaterThan(newIdx)
  })

  test('list page links to /plugins/new and /plugins/$id (no inline editor)', () => {
    const src = read('routes/plugins.tsx')
    expect(src).toContain('"/plugins/new"')
    expect(src).toContain('"/plugins/$id"')
    // Regression guard: the first RFC-031 cut had an inline editor with
    // these form ids. The migrated list page should NOT contain them; they
    // now live on the dedicated routes via <PluginFields>.
    expect(src).not.toContain('plugin-form-name')
    expect(src).not.toContain('plugin-form-spec')
  })

  test('new page uses shared PluginFields + posts /api/plugins', () => {
    const src = read('routes/plugins.new.tsx')
    expect(src).toContain('PluginFields')
    expect(src).toContain('/api/plugins')
    expect(src).toContain('plugin-save-button')
    // Test anchor in PluginFields contract.
    const fields = read('components/PluginFields.tsx')
    expect(fields).toContain('plugin-form-name')
    expect(fields).toContain('plugin-form-spec')
    expect(fields).toContain('plugin-form-options')
  })

  test('detail page locks name + has Save / Delete + uses shared PluginFields', () => {
    const src = read('routes/plugins.detail.tsx')
    expect(src).toContain('PluginFields')
    expect(src).toContain('nameLocked')
    expect(src).toContain('plugin-save-button')
    expect(src).toContain('ConfirmButton')
  })

  test('list page still keeps check-update + upgrade row actions', () => {
    const src = read('routes/plugins.tsx')
    expect(src).toContain('plugin-check-update-')
    expect(src).toContain('plugin-upgrade-')
  })

  test('i18n bundles agree on plugin keys (incl. new / detail page text)', () => {
    const en = read('i18n/en-US.ts')
    const zh = read('i18n/zh-CN.ts')
    const KEYS = [
      'title',
      'hint',
      'newButton',
      'newTitle',
      'newHint',
      'detailHint',
      'colName',
      'colSpec',
      'colSource',
      'colVersion',
      'colEnabled',
      'fieldName',
      'fieldSpec',
      'fieldOptions',
      'checkUpdateButton',
      'upgradeButton',
      'errorOptionsJson',
    ]
    for (const k of KEYS) {
      expect(en).toContain(`${k}:`)
      expect(zh).toContain(`${k}:`)
    }
    expect(en).toMatch(/^\s*plugins: \{/m)
    expect(zh).toMatch(/^\s*plugins: \{/m)
  })

  test('page sources rely on i18n — no hardcoded English / Chinese titles', () => {
    for (const rel of [
      'routes/plugins.tsx',
      'routes/plugins.new.tsx',
      'routes/plugins.detail.tsx',
    ]) {
      const src = read(rel)
      expect(src).not.toMatch(/<h1>Plugins?<\/h1>/)
      expect(src).not.toMatch(/<h1>插件<\/h1>/)
      expect(src).not.toMatch(/<h1>New plugin<\/h1>/)
      expect(src).not.toMatch(/<h1>新建插件<\/h1>/)
    }
  })
})
