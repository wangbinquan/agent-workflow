// P-5-03 stage 1: i18n bootstrap + ApiError mapping.

import { describe, expect, test } from 'vitest'
import { ApiError } from '@/api/client'
import i18n, { describeApiError, setLanguage } from '@/i18n'

describe('i18n init', () => {
  test('defaults to zh-CN', () => {
    // Detector may pick navigator.language under happy-dom; force zh-CN so the
    // assertion is stable. setLanguage flips i18n + localStorage cache.
    setLanguage('zh-CN')
    expect(i18n.language).toBe('zh-CN')
    expect(i18n.t('nav.agents')).toBe('代理')
    expect(i18n.t('nav.workflows')).toBe('工作流')
  })

  test('en-US bundle is reachable', () => {
    setLanguage('en-US')
    expect(i18n.t('nav.agents')).toBe('Agents')
    setLanguage('zh-CN')
  })
})

describe('describeApiError', () => {
  test('maps known error codes to localized strings', () => {
    setLanguage('zh-CN')
    const err = new ApiError(409, 'task-not-cancelable', 'task is already done')
    // RFC-202 T3: awaiting_* is now cancelable, so the 409 only fires on true
    // terminal states — the copy stopped claiming "已结束" for tasks that
    // hadn't ended (audit F-15's misleading wording).
    expect(describeApiError(err)).toBe('该任务已处于终态，无法取消。')
  })

  test('falls back to "<localized fallback>: <message>" for unknown codes', () => {
    setLanguage('zh-CN')
    const err = new ApiError(500, 'mystery-code', 'boom')
    expect(describeApiError(err)).toBe('请求失败: boom')
  })

  test('non-ApiError values are stringified', () => {
    expect(describeApiError(new Error('oops'))).toBe('oops')
    expect(describeApiError('plain')).toBe('plain')
  })
})
