// RFC-156 — "System agents" tab: source + i18n grep locks for tab placement and
// the internal-agent runtime/run-config wiring. Mounting the full settings route
// is heavy; settings-system-agents-render.test.tsx exercises the live PUT bodies,
// this file pins the structural facts a refactor could silently drift.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { SETTINGS_TABS, validateSettingsSearch, withSettingsTab } from '../src/routes/settings'

const SETTINGS = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'settings.tsx'),
  'utf-8',
)
const SETTINGS_DRAFTS = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'lib', 'settings-drafts.ts'),
  'utf-8',
)
const FUSION_DRAFT = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'components', 'settings', 'useFusionAgentDraft.ts'),
  'utf-8',
)
const ZH = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf-8')
const EN = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf-8')

describe('RFC-198 — Settings URL tab shell', () => {
  test('schema accepts every stable wire key and rejects missing/unknown values', () => {
    for (const tab of SETTINGS_TABS) expect(validateSettingsSearch({ tab })).toEqual({ tab })
    expect(validateSettingsSearch({})).toEqual({})
    expect(validateSettingsSearch({ tab: 'unknown' })).toEqual({})
    expect(validateSettingsSearch({ tab: 42 })).toEqual({})
    expect(validateSettingsSearch({ tab: 'limits', focus: 'runtime-card' })).toEqual({
      tab: 'limits',
      focus: 'runtime-card',
    })
    expect(validateSettingsSearch({ tab: 'unknown', focus: 'runtime-card' })).toEqual({
      focus: 'runtime-card',
    })
  })

  test('functional tab updates preserve adjacent search state', () => {
    expect(withSettingsTab({ focus: 'runtime-card', tab: 'limits' }, 'network')).toEqual({
      focus: 'runtime-card',
      tab: 'network',
    })
  })

  test('route uses URL authority, replace canonicalization, and stable section ids', () => {
    expect(SETTINGS).toContain('validateSearch: validateSettingsSearch')
    expect(SETTINGS).toContain('const search = Route.useSearch()')
    expect(SETTINGS).toContain('const navigate = Route.useNavigate()')
    expect(SETTINGS).toContain("const tab = isSettingsTab(search.tab) ? search.tab : 'runtime'")
    expect(SETTINGS).toContain('if (isSettingsTab(search.tab)) return')
    expect(SETTINGS).toContain("withSettingsTab(previous, 'runtime')")
    expect(SETTINGS).toContain("hash: hash === 'runtime' ? '' : hash")
    expect(SETTINGS).toContain('replace: true')
    expect(SETTINGS).toContain('<PageSectionNav<SettingsTab>')
    expect(SETTINGS).toContain('idPrefix="settings"')
    expect(SETTINGS).toContain("ariaLabel={t('settings.sectionNavLabel')}")
    expect(SETTINGS).toContain('pageSectionCurrent={destination.ariaCurrent}')
    expect(SETTINGS).toContain('aria-labelledby={`settings-section-title-${tab}`}')
    expect(SETTINGS).toContain('id={`settings-section-title-${tab}`}')
  })

  test('shared shell and async states replace settings-local chrome', () => {
    expect(SETTINGS).toContain("<PageHeader title={t('settings.title')} />")
    expect(SETTINGS).toContain("<LoadingState label={t('settings.loading')} />")
    // RFC-214: retry收编到 ErrorBanner.onRetry (was a hand-written retryAction button).
    expect(SETTINGS).toContain(
      '<ErrorBanner error={config.error} onRetry={() => void config.refetch()} />',
    )
  })
})

describe('RFC-156 — section placement', () => {
  test('section union + execution group include systemAgents and drop the Memory section', () => {
    expect(SETTINGS).toContain("'systemAgents'")
    expect(SETTINGS).toContain("key: 'execution'")
    expect(SETTINGS).toContain("key: 'systemAgents'")
    expect(SETTINGS).toContain("label: t('settings.tabSystemAgents')")
    // The Memory section is gone from navigation + dispatch. Its i18n label key stays
    // (locked by i18n-distill-output-lang-keys.test.ts) but is no longer rendered.
    expect(SETTINGS).not.toContain("t('settings.tabMemory')")
    expect(SETTINGS).not.toContain('<MemoryTab')
    expect(SETTINGS).not.toContain('function MemoryTab')
  })
  test('dispatch renders SystemAgentsTab', () => {
    expect(SETTINGS).toContain('<SystemAgentsTab config={config.data} fusionDraft={fusionDraft} />')
  })
})

describe('RFC-156 — SystemAgentsTab slice + D6 model clearing', () => {
  test('useTabState slice carries all three runtimes, their models, and commit/lang knobs', () => {
    for (const key of [
      'commitPushRuntime',
      'commitPushModel',
      'commitPushMaxRepairRetries',
      'commitPushDiffMaxBytes',
      'commitPushLang', // RFC-157
      'memoryDistillRuntime',
      'memoryDistillModel',
      'memoryDistillLang',
      'mergeAgentRuntime',
      'mergeAgentModel',
    ]) {
      expect(SETTINGS_DRAFTS).toContain(`'${key}'`)
    }
  })

  test('D6: each runtime selector nulls its paired deprecated model on change', () => {
    expect(SETTINGS).toContain('commitPushRuntime: v, commitPushModel: null')
    expect(SETTINGS).toContain('memoryDistillRuntime: v, memoryDistillModel: null')
    expect(SETTINGS).toContain('mergeAgentRuntime: v, mergeAgentModel: null')
  })

  test('merge runtime selector is bound + labelled (was UI-less before RFC-156)', () => {
    expect(SETTINGS).toMatch(/state\.mergeAgentRuntime/)
    expect(SETTINGS).toContain("t('settingsForm.mergeAgentRuntime')")
  })

  test('LimitsTab no longer carries any commit-push knob (no re-home)', () => {
    const limits = SETTINGS.slice(
      SETTINGS.indexOf('function LimitsTab'),
      SETTINGS.indexOf('function RecoveryTab'),
    )
    expect(limits.length).toBeGreaterThan(0)
    expect(limits).not.toContain('commitPush')
  })
})

describe('RFC-156 — fusion card writes a runtime-only patch to the builtin agent', () => {
  test('resolves the builtin semantically, then patches its canonical id with a runtime-only body', () => {
    expect(FUSION_DRAFT).toContain("'/api/agents/builtins/skill-merger'")
    expect(FUSION_DRAFT).toContain('/api/agents/${SKILL_MERGER_AGENT_ID}')
    // Body MUST be exactly `{ runtime }` — any extra key re-trips the RFC-104
    // builtin read-only lock (403 builtin-readonly).
    expect(FUSION_DRAFT).toContain('{ runtime })')
  })
})

describe('RFC-156 — i18n keys present in both locales', () => {
  test('zh-CN', () => {
    expect(ZH).toContain("tabSystemAgents: '系统 Agent'")
    expect(ZH).toContain("mergeAgentRuntime: '合并冲突运行时'")
    expect(ZH).toContain("commitPushTitle: '提交推送'")
    expect(ZH).toContain("fusionTitle: '技能融合'")
    expect(ZH).toContain("fusionRuntime: '融合运行时'")
  })
  test('en-US', () => {
    expect(EN).toContain("tabSystemAgents: 'System agents'")
    expect(EN).toContain("mergeAgentRuntime: 'Merge-conflict runtime'")
    expect(EN).toContain("commitPushTitle: 'Commit & push'")
    expect(EN).toContain("fusionTitle: 'Skill fusion'")
    expect(EN).toContain("fusionRuntime: 'Fusion runtime'")
  })
})
