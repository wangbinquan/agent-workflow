// RFC-032 / RFC-198 — source-code-level guard that the extracted shell is
// wired to the grouped navigation primitives, not a legacy flat link loop.
//
// Why this regression test exists: a future refactor that re-imports the
// flat NAV list (or removes the NavGroup / SettingsGearButton wiring) would
// silently revert PR1 of the nav redesign. Source-code grep catches it at
// PR review time and pairs naturally with `shell-no-theme-toggle.test.ts`.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const rootTsx = readFileSync(resolve(here, '../src/routes/__root.tsx'), 'utf8')
const appShellTsx = readFileSync(resolve(here, '../src/components/shell/AppShell.tsx'), 'utf8')
const shellNavigationTsx = readFileSync(
  resolve(here, '../src/components/shell/ShellNavigation.tsx'),
  'utf8',
)
const navGroupTsx = readFileSync(resolve(here, '../src/components/shell/NavGroup.tsx'), 'utf8')

describe('RFC-032 shell wiring — extracted components retain the grouped navigation', () => {
  test('__root delegates to AppShell, which owns active resolution', () => {
    expect(rootTsx).toMatch(/from '@\/components\/shell\/AppShell'/)
    expect(rootTsx).toMatch(/<AppShell pathname=\{pathname\}>/)
    expect(appShellTsx).toMatch(/resolveActiveNav\(pathname\)/)
  })

  test('ShellNavigation maps NAV_GROUPS through the real NavGroup component', () => {
    expect(shellNavigationTsx).toMatch(/from '\.\/NavGroup'/)
    expect(shellNavigationTsx).toMatch(/NAV_GROUPS\.map/)
    expect(shellNavigationTsx).toMatch(/<NavGroup\s/)
    expect(shellNavigationTsx).toMatch(/<ResourceIcon name="home"/)
    expect(navGroupTsx).toMatch(/<ResourceIcon name=\{item\.icon\}/)
    expect(navGroupTsx).not.toMatch(/nav-group__chevron|▾/)
  })

  test('renders <SettingsGearButton> + LanguageSwitch inside the shared footer', () => {
    expect(appShellTsx).toMatch(/<SettingsGearButton\s/)
    expect(appShellTsx).toMatch(/<LanguageSwitch\s*\/>/)
    expect(appShellTsx).toMatch(/sidebar__footer/)
  })

  test('renders a top-level Home link (PR1 acceptance #1)', () => {
    // `to="/"` lives on the home link. We don't pin the exact JSX shape,
    // just that the home `to` literal is present in the file.
    expect(shellNavigationTsx).toMatch(/to="\/"/)
    expect(shellNavigationTsx).toMatch(/nav-item--home/)
  })
})
