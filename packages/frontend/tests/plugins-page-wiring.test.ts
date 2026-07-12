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
    // RFC-032 lifted the sidebar nav into `lib/nav.ts::NAV_GROUPS` — the
    // /plugins entry now lives under the agents group.
    const nav = read('lib/nav.ts')
    expect(nav).toContain("to: '/plugins'")
  })

  test('router registers list + new + detail routes (literal before $param)', () => {
    // RFC-169: /plugins is a split layout route; new / detail / index are nested
    // children via addChildren (the import now also pulls in IndexRoute).
    const router = read('router.tsx')
    expect(router).toContain("Route as pluginsRoute } from '@/routes/plugins'")
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
    expect(src).toContain("to: '/plugins/$id'")
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
    // RFC-151 PR-4: the delete ConfirmButton renders inside the shared
    // <DetailHeaderActions> header shell now.
    expect(src).toContain('DetailHeaderActions')
    expect(read('components/DetailHeaderActions.tsx')).toContain('ConfirmButton')
  })

  test('detail page renders save/del errors in dedicated .form-actions row, NOT inside header .page__actions', () => {
    // Regression: previously the detail page rendered `<span class="form-actions__error">`
    // for save.error / del.error as a child of `<div className="page__actions">` in
    // the page header. That header row is `display:flex; justify-content:space-between`,
    // so a long error like "plugin-install-failed: plugin install failed (exit 1)" got
    // squeezed into the top-right corner of the page, visually disconnected from the
    // form it pertains to. RFC-151 PR-4 single-sourced the placement in
    // <DetailHeaderActions>: the `.form-actions` error row renders as a SIBLING
    // after the flex header, never inside the `.page__actions` cluster. Lock the
    // structural property on the shared shell + the page's wiring through it.
    const shell = read('components/DetailHeaderActions.tsx')
    expect(shell).toContain('className="form-actions"')
    expect(shell).toContain('form-actions__error')
    const headerBlock = shell.match(
      /<header className="page__header page__header--row">[\s\S]*?<\/header>/,
    )
    expect(headerBlock).not.toBeNull()
    expect(headerBlock![0]).toContain('className="page__actions"')
    expect(headerBlock![0]).not.toContain('form-actions__error')
    // plugins.detail routes both mutation channels through the shell's slot.
    const src = read('routes/plugins.detail.tsx')
    expect(src).toMatch(/errors=\{\[save\.error, del\.error\]\}/)
  })

  // RFC-169: check-update + upgrade moved off the list row into the detail
  // "Updates" tab; the list card lights up an "update available" chip read from
  // the shared ['plugins','updates'] cache.
  test('detail Updates tab hosts check-update + upgrade; list card shows the update chip', () => {
    const detail = read('routes/plugins.detail.tsx')
    expect(detail).toContain('plugin-check-update')
    expect(detail).toContain('plugin-upgrade')
    expect(detail).toContain("key: 'updates'")
    const list = read('routes/plugins.tsx')
    expect(list).toContain('plugin-update-')
    expect(list).toContain('PLUGIN_UPDATES_KEY')
  })

  test('i18n bundles agree on plugin keys (incl. new / detail page text)', () => {
    const en = read('i18n/en-US.ts')
    const zh = read('i18n/zh-CN.ts')
    const KEYS = [
      'title',
      'newButton',
      'newTitle',
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
