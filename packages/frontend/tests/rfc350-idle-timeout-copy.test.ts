// RFC-350 —— 被收割任务在界面上的说法（AC-7 / AC-8）与小时单位的显示。
//
// 为什么这些测试存在：收割写进任务行的是机器 token `task-idle-timeout`。它必须在
// 详情页被翻成中文并带上「怎么办」的提示，而不是把英文 token 甩给用户——RFC-203 T4
// 建立的三层 oracle 正是为此存在，新写手漏登记 EXACT_TOKENS 就会静默退回 generic 文案。
// 同理，`idle-timeout-reap` 这条恢复事件不登记就会在「恢复」区显示成裸 code。
// 小时单位是本 RFC 新引入的 NumberRangeUnit，一并锁住它的换算。

import { beforeAll, describe, expect, test } from 'vitest'

import i18n, { setLanguage } from '../src/i18n'
import { describeTaskFailure } from '../src/lib/task-failure'
import { formatUnitValue } from '../src/lib/formatUnit'
import { RECOVERY_EVENT_KINDS } from '../src/components/tasks/RecoverySection'

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    if (i18n.isInitialized) resolve()
    else i18n.on('initialized', () => resolve())
  })
  setLanguage('zh-CN')
})

describe('RFC-350 收割原因文案', () => {
  test('task-idle-timeout 翻成中文并带处置提示，原始 token 只留在详情块', () => {
    const copy = describeTaskFailure({
      errorSummary: 'task-idle-timeout',
      errorMessage: 'task had no activity for 108000000ms, exceeding the configured idle timeout',
    })
    expect(copy.matched).toBe('summary-token')
    expect(copy.title).not.toContain('task-idle-timeout')
    expect(copy.title).toContain('没有任何活动')
    expect(copy.hint).toBeDefined()
    expect(copy.raw).toBe('task-idle-timeout')
  })

  test('en-US 同样有文案（不会退回 generic）', async () => {
    setLanguage('en-US')
    const copy = describeTaskFailure({ errorSummary: 'task-idle-timeout' })
    expect(copy.matched).toBe('summary-token')
    expect(copy.title.toLowerCase()).toContain('no activity')
    setLanguage('zh-CN')
  })
})

describe('RFC-350 恢复事件', () => {
  test('idle-timeout-reap 已登记，且两种语言都有文案', () => {
    expect(RECOVERY_EVENT_KINDS).toContain('idle-timeout-reap')
    for (const language of ['zh-CN', 'en-US'] as const) {
      setLanguage(language)
      const label = i18n.t('tasks.recovery.kind.idle-timeout-reap')
      expect(label).not.toBe('tasks.recovery.kind.idle-timeout-reap')
      expect(label.length).toBeGreaterThan(3)
    }
    setLanguage('zh-CN')
  })
})

describe('RFC-350 小时单位', () => {
  test('一个量级、不向下穿透：24 的整数倍显示成天，小于 24 显示成小时', () => {
    const t = i18n.t.bind(i18n)
    expect(formatUnitValue(1, 'hours', t)).toBe(t('unit.hour', { count: 1 }))
    expect(formatUnitValue(23, 'hours', t)).toBe(t('unit.hour', { count: 23 }))
    expect(formatUnitValue(24, 'hours', t)).toBe(t('unit.day', { count: 1 }))
    expect(formatUnitValue(48, 'hours', t)).toBe(t('unit.day', { count: 2 }))
    // 出厂默认就是 168 小时 = 7 天，设置页上必须显示成「7 天」而不是一个裸数字。
    expect(formatUnitValue(168, 'hours', t)).toBe(t('unit.day', { count: 7 }))
    expect(formatUnitValue(8760, 'hours', t)).toBe(t('unit.day', { count: 365 }))
    // 25 小时不是整天：按 formatUnitValue 的既有约定**不**退回小时档（那会把
    // 「1.04 天」说成「25 小时」，隐藏真实量级），而是不给紧凑提示。与 ms 档
    // 的 90_000ms 同一条规则。
    expect(formatUnitValue(25, 'hours', t)).toBeNull()
    expect(formatUnitValue(0, 'hours', t)).toBe('0')
  })
})
