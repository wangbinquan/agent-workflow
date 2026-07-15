// RFC-198 PR2 — source locks for ownership and event ordering that are hard
// to observe from a DOM snapshot alone.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (path: string) => readFileSync(resolve(here, path), 'utf8')
const rootSource = readSource('../src/routes/__root.tsx')
const appShellSource = readSource('../src/components/shell/AppShell.tsx')
const navigationSource = readSource('../src/components/shell/ShellNavigation.tsx')
const mobileDialogSource = readSource('../src/components/shell/MobileNavDialog.tsx')
const transitionSource = readSource('../src/components/shell/RouteTransitionState.tsx')

describe('RFC-198 root shell source contract', () => {
  test('keeps the fixed auth -> token-null transition -> authenticated branch order', () => {
    const authBranch = rootSource.indexOf("if (pathname === '/auth')")
    const tokenBranch = rootSource.indexOf('if (token === null)')
    const authenticatedBranch = rootSource.indexOf('return <AppShell')
    expect(authBranch).toBeGreaterThan(-1)
    expect(tokenBranch).toBeGreaterThan(authBranch)
    expect(authenticatedBranch).toBeGreaterThan(tokenBranch)
    expect(rootSource.slice(authBranch, tokenBranch)).toMatch(
      /<BareShell>\s*\{children\}\s*<\/BareShell>/,
    )
    expect(rootSource.slice(tokenBranch, authenticatedBranch)).toMatch(
      /<RouteTransitionState\s*\/>/,
    )
  })

  test('root delegates authenticated chrome and retains beforeLoad as redirect authority', () => {
    expect(rootSource).toMatch(/from '@\/components\/shell\/AppShell'/)
    expect(rootSource).toMatch(/beforeLoad:/)
    expect(rootSource).toMatch(/throw redirect\(/)
    expect(rootSource).not.toMatch(/NAV_GROUPS|InboxFooterButton|SettingsGearButton|<aside/)
  })
})

describe('RFC-198 AppShell source contract', () => {
  test('uses one 900px matchMedia snapshot with desktop fallback and conditional shell DOM', () => {
    expect(appShellSource).toContain("const COMPACT_SHELL_QUERY = '(max-width: 900px)'")
    expect(appShellSource).toMatch(
      /useSyncExternalStore\(subscribeCompactShell, compactSnapshot, \(\) => false\)/,
    )
    expect(appShellSource).toMatch(/\{compact \? \(/)
    expect(appShellSource).toMatch(/compact && mobileNavOpen && !inboxOpen/)
  })

  test('keeps one stable focusable main and supplies it as dialog restore fallback', () => {
    expect(appShellSource).toMatch(/<main ref=\{mainRef\}[^>]*tabIndex=\{-1\}/)
    expect(appShellSource).toMatch(/restoreFocusFallbackRef=\{mainRef\}/)
    expect(mobileDialogSource).toMatch(/restoreFocusFallbackRef=\{restoreFocusFallbackRef\}/)
  })

  test('prepares mobile navigation before router Link click without imperative navigation', () => {
    const prepareStart = appShellSource.indexOf('const prepareMobileNavigation')
    const prepareEnd = appShellSource.indexOf('const toggleCompactInbox', prepareStart)
    const prepareBody = appShellSource.slice(prepareStart, prepareEnd)
    expect(prepareBody.indexOf('focusStableTrigger(menuTriggerRef.current)')).toBeGreaterThan(-1)
    expect(prepareBody.indexOf('pendingNavigationRef.current = destination')).toBeGreaterThan(
      prepareBody.indexOf('focusStableTrigger(menuTriggerRef.current)'),
    )
    expect(prepareBody.indexOf('setMobileNavOpen(false)')).toBeGreaterThan(
      prepareBody.indexOf('pendingNavigationRef.current = destination'),
    )
    expect(navigationSource).toMatch(/onClickCapture=\{captureNavigation\}/)
    expect(navigationSource).not.toMatch(/location\.href|useNavigate/)
  })

  test('route commit focuses the first h1 with main fallback only after pathname changes', () => {
    expect(transitionSource).toMatch(/querySelector<HTMLElement>\('h1'\)/)
    expect(transitionSource).toMatch(/previousPathnameRef\.current === pathname/)
    expect(transitionSource).toMatch(/if \(destination === null\) return/)
    expect(transitionSource).toMatch(/main\.focus\(/)
    expect(transitionSource).toMatch(/size="compact"/)
    expect(transitionSource).toMatch(/common\.redirectingToLogin/)
  })

  test('desktop resize only transfers focus when an open compact menu loses its trigger', () => {
    const effectStart = appShellSource.indexOf('const wasCompact = previousCompactRef.current')
    const effectEnd = appShellSource.indexOf('return (', effectStart)
    const resizeEffect = appShellSource.slice(effectStart, effectEnd)
    expect(resizeEffect).toMatch(/if \(!wasCompact \|\| compact\) return/)
    expect(resizeEffect).toMatch(/if \(!mobileNavOpen\) return/)
    expect(resizeEffect).toMatch(/mainRef\.current\?\.focus/)
  })
})
