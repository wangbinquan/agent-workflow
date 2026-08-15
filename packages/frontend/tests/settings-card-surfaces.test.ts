// RFC-299 — full-surface source ratchet for the settings card migration.
//
// Render tests cover the shared primitive and feature tests cover mutations.
// This guard owns the set property those tests cannot see: all eleven settings
// sections plus both secondary editors must keep their semantic card groups,
// and the retired feature-local card chrome must not return.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const read = (path: string) => readFileSync(resolve(import.meta.dirname, '..', 'src', path), 'utf8')

const settings = read('routes/settings.tsx')
const runtimes = read('components/RuntimeList.tsx')
const codeHosts = read('components/settings/CodeHostsSection.tsx')
const styles = read('styles.css')
const en = read('i18n/en-US.ts')
const zh = read('i18n/zh-CN.ts')

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(startIndex, `missing source boundary: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endIndex, `missing source boundary: ${end}`).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

function count(source: string, token: string): number {
  return source.split(token).length - 1
}

describe('RFC-299 — every settings surface uses semantic SettingsCard groups', () => {
  test.each([
    ['limits', 'function LimitsTab', 'function RecoveryTab', 3],
    ['recovery', 'function RecoveryTab', 'function GitTab', 2],
    ['git', 'function GitTab', 'export function GcTab', 2],
    ['network', 'export function NetworkTab', 'export function AppearanceTab', 2],
    ['appearance', 'export function AppearanceTab', '// RFC-156/234', 1],
    ['system agents', 'export function SystemAgentsTab', 'function RenderingTab', 6],
    ['rendering', 'function RenderingTab', '// RFC-036 — OIDC providers', 1],
    ['authentication', 'function AuthenticationTab', '// RFC-286 F3', 2],
  ])('%s section keeps its expected card count', (_name, start, end, expected) => {
    expect(count(between(settings, start, end), '<SettingsCard')).toBe(expected)
  })

  test('GC owns three retention cards plus its cardized backup/restore group', () => {
    const gc = between(settings, 'export function GcTab', '// GET /api/restore')
    expect(
      count(gc, '<SettingsCard'),
    ).toBe(3)
    expect(gc).toContain("usePermission('backup:run')")
    expect(gc).toContain('<BackupCard canRun={canRunBackup} />')
    expect(
      count(between(settings, 'export function BackupCard', '// GET /api/daemon'), '<SettingsCard'),
    ).toBe(1)
  })

  test('runtime registry and its two editor groups use one shared primitive', () => {
    expect(count(runtimes, '<SettingsCard')).toBe(3)
    expect(runtimes).toContain("title={t('runtimes.title')}")
    expect(runtimes).toContain("title={t('runtimes.launchTitle')}")
    expect(runtimes).toContain("title={t('runtimes.profileTitle')}")
  })

  test('both code-host providers render through the same connection card', () => {
    expect(codeHosts).toContain(
      "const PROVIDERS: readonly CodeHostProvider[] = ['gitlab', 'github']",
    )
    expect(codeHosts).toContain('<div className="form-grid" data-testid="code-hosts-section">')
    expect(
      count(
        between(codeHosts, 'function ConnectionCard', 'export function CodeHostsSection'),
        '<SettingsCard',
      ),
    ).toBe(1)
    expect(codeHosts).toContain('PROVIDERS.map((provider) =>')
  })

  test('OIDC keeps four native labelled fieldset cards', () => {
    const dialog = between(settings, 'function OidcProviderDialog', 'interface SectionFormProps')
    expect(count(dialog, '<SettingsCard')).toBe(4)
    expect(count(dialog, 'as="fieldset"')).toBe(4)
    expect(count(dialog, 'as="fieldset"\n            disabled={busy}')).toBe(4)
  })
})

describe('RFC-299 — retired private card chrome cannot return', () => {
  test('settings sources contain no feature-local card shells', () => {
    for (const retired of [
      'function AgentCard',
      'system-agent-card',
      'auth-tab__header',
      'auth-tab__title',
      'oidc-form__group',
      'runtime-list__header--actions-only',
      'showHeading',
    ]) {
      expect(settings + runtimes + codeHosts + styles, retired).not.toContain(retired)
    }
    expect(codeHosts).not.toContain('<section className="page__section"')
  })

  test('all new group titles and hints exist in both locales', () => {
    for (const key of [
      'limitsBudgets',
      'limitsConcurrency',
      'limitsLogging',
      'recoveryAutomation',
      'recoverySafety',
      'gitCheckout',
      'gitRefresh',
      'gcWorktrees',
      'gcEvents',
      'gcWebhooks',
      'networkListener',
      'networkExternal',
      'appearanceDisplay',
      'renderingService',
    ]) {
      for (const locale of [en, zh]) {
        expect(locale, `${key}Title`).toContain(`${key}Title:`)
        expect(locale, `${key}Hint`).toContain(`${key}Hint:`)
      }
    }
    for (const key of ['launch', 'profile']) {
      for (const locale of [en, zh]) {
        expect(locale, `${key}Title`).toContain(`${key}Title:`)
        expect(locale, `${key}Hint`).toContain(`${key}Hint:`)
      }
    }
  })
})
