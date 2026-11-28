// RFC-626 §3.2.4 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md) —— 被自动升级结束的
// 任务在界面上的说法。
//
// 为什么这些测试存在：升级把接不上的未结束任务改写成已取消，并在任务行的 error_summary 里写下
// 机器字面量 `ended by upgrade`。任务详情的元信息栏在 errorSummary 非空时显示它；RFC-203 T4
// 的原因表按字面量把它翻成给人看的话。新原因漏登记 EXACT_TOKENS，或者两份语言包缺了这个键，
// 都会静默退回通用文案——用户看到的就是「任务失败」而不知道是升级结束的。文案取设计原文。

import { beforeAll, describe, expect, test } from 'vitest'

import i18n, { SUPPORTED_LANGUAGES, setLanguage } from '../src/i18n'
import { describeTaskFailure } from '../src/lib/task-failure'

const KEY = 'tasks.failure.summary.endedByUpgrade'
const COPY = {
  'zh-CN': '升级时结束：旧版本的运行记录无法在新版本继续。',
  'en-US': 'Ended during the upgrade: its records from the previous version cannot be continued.',
} as const

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    if (i18n.isInitialized) resolve()
    else i18n.on('initialized', () => resolve())
  })
  setLanguage('zh-CN')
})

describe('RFC-626 升级结束任务的原因文案', () => {
  test('ended by upgrade 翻成中文，机器字面量只留在详情块', () => {
    const copy = describeTaskFailure({
      errorSummary: 'ended by upgrade',
      errorMessage: 'ended-by-upgrade',
    })
    expect(copy.matched).toBe('summary-token')
    expect(copy.title).toBe(COPY['zh-CN'])
    expect(copy.title).not.toContain('ended by upgrade')
    expect(copy.raw).toBe('ended by upgrade')
  })

  test('en-US 同样有文案（不会退回 generic）', () => {
    setLanguage('en-US')
    try {
      const copy = describeTaskFailure({ errorSummary: 'ended by upgrade' })
      expect(copy.matched).toBe('summary-token')
      expect(copy.title).toBe(COPY['en-US'])
    } finally {
      setLanguage('zh-CN')
    }
  })

  test('两份语言包都有这个键，取到的不是键名也不是另一种语言的回落', () => {
    expect([...SUPPORTED_LANGUAGES].sort()).toEqual(Object.keys(COPY).sort())
    for (const language of SUPPORTED_LANGUAGES) {
      expect(i18n.exists(KEY, { lng: language, fallbackLng: false })).toBe(true)
      expect(i18n.t(KEY, { lng: language, fallbackLng: false })).toBe(COPY[language])
    }
  })

  test('按字面量对应：差一点的摘要不算，退回通用文案并保留原文', () => {
    for (const summary of ['ended-by-upgrade', 'ended by upgrade: x', 'Ended by upgrade']) {
      const copy = describeTaskFailure({ errorSummary: summary })
      expect(copy.matched).toBe('generic')
      expect(copy.title).not.toBe(COPY['zh-CN'])
      expect(copy.raw).toBe(summary)
    }
  })
})
