// RFC-156 — "System agents" tab: source + i18n grep locks for tab placement and
// the internal-agent runtime/run-config wiring. Mounting the full settings route
// is heavy; settings-system-agents-render.test.tsx exercises the live PUT bodies,
// this file pins the structural facts a refactor could silently drift.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SETTINGS = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'settings.tsx'),
  'utf-8',
)
const ZH = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf-8')
const EN = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf-8')

describe('RFC-156 — tab placement', () => {
  test('Tab union + TabBar list gain systemAgents and drop the Memory tab', () => {
    expect(SETTINGS).toContain("'systemAgents'")
    expect(SETTINGS).toContain("['systemAgents', t('settings.tabSystemAgents')]")
    // The Memory tab is gone from the bar + dispatch. Its i18n label key stays
    // (locked by i18n-distill-output-lang-keys.test.ts) but is no longer rendered.
    expect(SETTINGS).not.toContain("t('settings.tabMemory')")
    expect(SETTINGS).not.toContain('<MemoryTab')
    expect(SETTINGS).not.toContain('function MemoryTab')
  })
  test('dispatch renders SystemAgentsTab', () => {
    expect(SETTINGS).toContain('<SystemAgentsTab config={config.data} />')
  })
})

describe('RFC-156 — SystemAgentsTab slice + D6 model clearing', () => {
  test('useTabState slice carries all three runtimes, their models, and commit/lang knobs', () => {
    for (const key of [
      'commitPushRuntime',
      'commitPushModel',
      'commitPushMaxRepairRetries',
      'commitPushDiffMaxBytes',
      'memoryDistillRuntime',
      'memoryDistillModel',
      'memoryDistillLang',
      'mergeAgentRuntime',
      'mergeAgentModel',
    ]) {
      expect(SETTINGS).toContain(`'${key}'`)
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
  test('targets aw-skill-merger via /api/agents with a runtime-only body', () => {
    expect(SETTINGS).toContain("SKILL_MERGER_AGENT_NAME = 'aw-skill-merger'")
    expect(SETTINGS).toContain('/api/agents/${SKILL_MERGER_AGENT_NAME}')
    // Body MUST be exactly `{ runtime }` — any extra key re-trips the RFC-104
    // builtin read-only lock (403 builtin-readonly).
    expect(SETTINGS).toContain('{ runtime })')
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
