// RFC-108 T24/T25 — Settings "Recovery" tab source + i18n parity guard.
//
// 为什么这条测试存在：自动恢复旋钮（autoResumeOnBoot / autoRepair / autoKill /
// 熔断窗口）是后端 default-OFF 能力的唯一启用入口。本测试锁定：① settings.tsx 有
// RecoveryTab 且复用公共组件 Switch/Field（不得落原生 <input className="form-input">
// 自写 chrome——CLAUDE.md 前台统一风格强制原则）；② 它接所有 RFC-108 config 键；
// ③ 新增 i18n 键在 zh-CN 与 en-US 双语齐全（漏一边即 missing-key 回归）。

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(path.resolve(here, p), 'utf8')
const settings = read('../src/routes/settings.tsx')
const zh = read('../src/i18n/zh-CN.ts')
const en = read('../src/i18n/en-US.ts')

const CONFIG_KEYS = [
  'autoResumeOnBoot',
  'autoRepair',
  'autoKillStalledChild',
  'heartbeatStallMs',
  'maxAutoRecoveriesPerWindow',
  'autoRecoveryWindowMs',
  'periodicOrphanReconcileMs',
]

const I18N_KEYS = [
  'settingsForm.autoResumeOnBoot',
  'settingsForm.autoResumeOnBootHint',
  'settingsForm.autoRepairS4',
  'settingsForm.autoKillStalledChild',
  'settingsForm.heartbeatStallMs',
  'settingsForm.maxAutoRecoveriesPerWindow',
  'settingsForm.autoRecoveryWindowMs',
  'settingsForm.periodicOrphanReconcileMs',
  'settingsForm.zeroDisabled',
]

describe('RFC-108 T24/T25 — Recovery settings tab', () => {
  test('settings.tsx has a RecoveryTab wired into page-section navigation + render', () => {
    expect(/function RecoveryTab\(/.test(settings)).toBe(true)
    expect(settings.includes("tab === 'recovery'")).toBe(true)
    expect(settings.includes("key: 'recovery'")).toBe(true)
    expect(settings.includes("label: t('settings.tabRecovery')")).toBe(true)
  })

  test('RecoveryTab reuses the shared Switch + Field primitives (no hand-rolled chrome)', () => {
    const start = settings.indexOf('function RecoveryTab(')
    const end = settings.indexOf('function GcTab(', start)
    const tabBody = settings.slice(start, end)
    expect(tabBody.includes('<Switch')).toBe(true)
    expect(tabBody.includes('<Field')).toBe(true)
    expect(tabBody.includes('<NumberInput')).toBe(true)
    // must NOT bypass the form primitives with a raw styled input
    expect(/<input\s+className="form-input"/.test(tabBody)).toBe(false)
  })

  test('RecoveryTab wires every RFC-108 auto-recovery config key', () => {
    for (const k of CONFIG_KEYS) {
      expect(settings.includes(k)).toBe(true)
    }
  })

  test('the tab label key (settings.tabRecovery) exists in zh + en', () => {
    expect(zh.includes('tabRecovery:')).toBe(true)
    expect(en.includes('tabRecovery:')).toBe(true)
  })

  test('every new settingsForm i18n key exists in BOTH zh-CN and en-US', () => {
    for (const full of I18N_KEYS) {
      const leaf = `${full.split('.').pop()!}:`
      expect(zh.includes(leaf), `zh-CN missing ${full}`).toBe(true)
      expect(en.includes(leaf), `en-US missing ${full}`).toBe(true)
    }
  })
})
