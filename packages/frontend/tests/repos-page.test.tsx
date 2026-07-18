// RFC-024 T7 — locks the source wiring + i18n key references for the
// /repos cached-repos management page. Behavioural tests (modal open /
// force=1 / row render) are covered by the e2e in T9; here we just keep
// the route registered + i18n keys present.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { zhCN } from '@/i18n/zh-CN'
import { enUS } from '@/i18n/en-US'

const REPOS_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'repos.tsx'),
  'utf-8',
)
const ROUTER_SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'router.tsx'), 'utf-8')
const NAV_SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'lib', 'nav.ts'), 'utf-8')
const ZH = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf-8')
const EN = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf-8')

describe('/repos page wiring (RFC-024)', () => {
  test('ReposRoute is registered in the router tree', () => {
    expect(ROUTER_SRC).toContain('ReposRoute')
    expect(ROUTER_SRC).toContain('reposRoute')
  })

  test('sidebar nav includes /repos entry', () => {
    // RFC-032 moved the sidebar nav into `lib/nav.ts::NAV_GROUPS`; /repos
    // now lives under the tasks group.
    expect(NAV_SRC).toContain("to: '/repos'")
  })

  test('repos.tsx calls the three /api/cached-repos endpoints', () => {
    expect(REPOS_SRC).toContain("'/api/cached-repos'")
    expect(REPOS_SRC).toContain('/refresh')
    expect(REPOS_SRC).toContain('?force=1')
  })

  test('RFC-198 shared chrome keeps the table and state contracts centralized', () => {
    expect(REPOS_SRC).toContain("import { PageHeader } from '@/components/PageHeader'")
    expect(REPOS_SRC).toContain("import { TableViewport } from '@/components/TableViewport'")
    expect(REPOS_SRC).toContain("import { ErrorBanner } from '@/components/ErrorBanner'")
    expect(REPOS_SRC).toContain("<TableViewport label={t('repos.title')}>")
    expect(REPOS_SRC).toContain('<ErrorBanner error={list.error} action={retryAction} />')
    expect(REPOS_SRC).toContain('<ErrorBanner error={refresh.error} />')
    expect(REPOS_SRC).not.toContain('<div className="error-box">')
  })

  test('renders only the redacted URL (no raw item.url interpolation)', () => {
    // The table cell uses `item.urlRedacted`; the only direct `item.url`
    // reference is the dialog's body where it passes through redactGitUrl.
    expect(REPOS_SRC).toContain('item.urlRedacted')
    // Any other `item.url` mention must be inside redactGitUrl(...).
    const lines = REPOS_SRC.split('\n')
    for (const ln of lines) {
      if (/\bitem\.url\b/.test(ln) && !/urlRedacted/.test(ln)) {
        expect(ln).toMatch(/redactGitUrl/)
      }
    }
  })

  test('zh + en i18n carry the repos.* namespace', () => {
    for (const src of [ZH, EN]) {
      expect(src).toContain('colUrl')
      expect(src).toContain('colLocalPath')
      expect(src).toContain('confirmDelete')
      expect(src).toContain('deleteConfirmTitle')
    }
  })

  // Regression: the /repos actions-column buttons (刷新 / 删除) shipped in the
  // zh-CN bundle as the raw English words 'Refresh' / 'Delete' — i.e. never
  // localized — so the Chinese UI rendered English button labels while every
  // other repos.* string was translated. repos.tsx wires them via
  // t('repos.refresh') / t('repos.delete'), so the leak lived purely in the
  // bundle value. Lock both action buttons to actual Chinese text so a future
  // edit can't silently re-introduce the English leak.
  test('zh-CN repos action buttons are localized, not left in English', () => {
    const CJK = /[一-鿿]/
    expect(zhCN.repos.refresh).toMatch(CJK)
    expect(zhCN.repos.delete).toMatch(CJK)
    // And they must differ from the English bundle's labels.
    expect(zhCN.repos.refresh).not.toBe(enUS.repos.refresh)
    expect(zhCN.repos.delete).not.toBe(enUS.repos.delete)
  })
})
