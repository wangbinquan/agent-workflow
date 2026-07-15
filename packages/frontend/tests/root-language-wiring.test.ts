// RFC-025 T4 / RFC-198 PR2 — source-level guard that the root applies the
// language and the extracted shared shell still renders its switcher.
//
// Why: if a future refactor accidentally drops the hook or the component
// from the sidebar layout, the running app silently regresses (no error,
// just the language switcher disappears). Lock both call sites at the
// source-text level.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = path.resolve(__dirname, '../src/routes/__root.tsx')
const APP_SHELL = path.resolve(__dirname, '../src/components/shell/AppShell.tsx')

describe('RFC-025 root + AppShell language wiring', () => {
  const rootSource = fs.readFileSync(ROOT, 'utf8')
  const appShellSource = fs.readFileSync(APP_SHELL, 'utf8')

  test('imports useApplyLanguage from @/hooks/useLanguage', () => {
    expect(rootSource).toMatch(/from\s+['"]@\/hooks\/useLanguage['"]/)
    expect(rootSource).toContain('useApplyLanguage')
  })

  test('AppShell imports LanguageSwitch from @/components/LanguageSwitch', () => {
    expect(appShellSource).toMatch(/from\s+['"]@\/components\/LanguageSwitch['"]/)
    expect(appShellSource).toContain('LanguageSwitch')
  })

  test('calls useApplyLanguage() inside the component body', () => {
    expect(rootSource).toMatch(/useApplyLanguage\(\s*\)/)
  })

  test('renders <LanguageSwitch /> inside the canonical shared footer', () => {
    expect(appShellSource).toMatch(/sidebar__footer/)
    expect(appShellSource).toMatch(/<LanguageSwitch\s*\/>/)
  })
})
