// RFC-075 + RFC-117 — guard the commit&push + memory-distill runtime knobs on
// Settings. RFC-117 replaced the per-feature `commitPushModel` / `memoryDistillModel`
// ModelSelect pickers with `commitPushRuntime` / `memoryDistillRuntime`
// RuntimeSelect profile pickers (model now comes from the chosen runtime profile).
// RFC-156 moved BOTH out of the Limits / Memory tabs into the new "System agents"
// tab (SystemAgentsTab) — these grep the whole settings.tsx so they stay green
// through the move; settings-system-agents.test.ts locks the new tab placement.
// Source + i18n grep (the settings route is heavy to mount); a regression that
// dropped a key from the useTabState slice would silently stop persisting it.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SETTINGS = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'settings.tsx'),
  'utf-8',
)
const ZH = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf-8')
const EN = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf-8')

describe('settings.tsx — RFC-117 commit&push runtime config', () => {
  test('persists runtime + repair keys in the System agents tab draft slice', () => {
    expect(SETTINGS).toContain("'commitPushRuntime'")
    expect(SETTINGS).toContain("'commitPushMaxRepairRetries'")
    expect(SETTINGS).toContain("'commitPushDiffMaxBytes'")
  })
  test('renders the commit runtime picker bound to state (RuntimeSelect, not ModelSelect)', () => {
    expect(SETTINGS).toMatch(/state\.commitPushRuntime/)
    expect(SETTINGS).toContain("t('settingsForm.commitPushRuntime')")
    expect(SETTINGS).toContain('RuntimeSelect')
    // the per-feature model picker is gone (model comes from the runtime profile).
    expect(SETTINGS).not.toContain('state.commitPushModel')
  })
})

describe('settings.tsx — RFC-117 memory-distill runtime config', () => {
  test('persists memoryDistillRuntime in the System agents tab draft slice', () => {
    expect(SETTINGS).toContain("'memoryDistillRuntime'")
    expect(SETTINGS).toMatch(/state\.memoryDistillRuntime/)
    expect(SETTINGS).toContain("t('settings.memoryDistillRuntimeLabel')")
    expect(SETTINGS).not.toContain('state.memoryDistillModel')
  })
})

describe('i18n — RFC-117 runtime settings keys present in both locales', () => {
  test('zh-CN', () => {
    expect(ZH).toContain("commitPushRuntime: '提交&推送运行时'")
    expect(ZH).toContain("memoryDistillRuntimeLabel: '记忆提炼运行时'")
    expect(ZH).toContain("runtimeInherit: '继承（全局默认）'")
  })
  test('en-US', () => {
    expect(EN).toContain("commitPushRuntime: 'Commit & push runtime'")
    expect(EN).toContain("memoryDistillRuntimeLabel: 'Memory distill runtime'")
    expect(EN).toContain("runtimeInherit: 'Inherit (global default)'")
  })
})
