// RFC-031 T11 — source-code wiring locks for the /plugins route.
//
// We don't render the full router component tree here; instead we assert the
// wiring from text patterns. This catches:
//   - sidebar nav loses the /plugins entry (regression to pre-RFC-031)
//   - router stops registering the pluginsRoute
//   - the page silently drops the "+ New plugin" button or table
//   - i18n keys diverge between en-US and zh-CN

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

  test('router registers pluginsRoute', () => {
    const router = read('router.tsx')
    expect(router).toContain("import { Route as pluginsRoute } from '@/routes/plugins'")
    expect(router).toContain('pluginsRoute,')
  })

  test('list page has the New button and check-update / upgrade actions', () => {
    const src = read('routes/plugins.tsx')
    expect(src).toContain('plugins-new-button')
    expect(src).toContain('plugin-check-update-')
    expect(src).toContain('plugin-upgrade-')
  })

  test('list page form has spec + options + enabled inputs', () => {
    const src = read('routes/plugins.tsx')
    expect(src).toContain('plugin-form-name')
    expect(src).toContain('plugin-form-spec')
    expect(src).toContain('plugin-form-options')
    expect(src).toContain('plugin-form-submit')
  })

  test('i18n bundles agree on plugin keys', () => {
    const en = read('i18n/en-US.ts')
    const zh = read('i18n/zh-CN.ts')
    const KEYS = [
      'title',
      'hint',
      'newButton',
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
    // Sanity: both files declare the `plugins` section.
    expect(en).toMatch(/^\s*plugins: \{/m)
    expect(zh).toMatch(/^\s*plugins: \{/m)
  })

  test('page source uses i18n (no hardcoded English / Chinese title)', () => {
    const src = read('routes/plugins.tsx')
    // The page must rely on t() for the title — not contain "Plugins" as a
    // hardcoded h1.
    expect(src).not.toMatch(/<h1>Plugins<\/h1>/)
    expect(src).not.toMatch(/<h1>插件<\/h1>/)
    expect(src).toContain("t('plugins.title')")
  })
})
