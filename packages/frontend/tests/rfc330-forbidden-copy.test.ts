// RFC-330 —— `employee-*` 错误码整族落在 digitalEmployee 域（此前兜底到 misc：
// 「请求失败」对用户毫无信息）；新码 employee-case-observer-read-only 同属该域。

import { describe, expect, test } from 'vitest'
import { domainOf } from '../src/i18n/errors'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'

describe('RFC-330 digitalEmployee 错误域', () => {
  test('employee-* 码落 digitalEmployee 域', () => {
    for (const code of [
      'employee-case-observer-read-only',
      'employee-case-not-found',
      'employee-tool-not-found',
      'employee-job-template-not-found',
      'employee-tool-binding-invalid',
    ]) {
      expect(domainOf(code), code).toBe('digitalEmployee')
    }
  })

  test('域标题与四个新码在两种语言的原始资源里都有精确文案（不经 fallback）', () => {
    const codes = [
      'employee-case-observer-read-only',
      'employee-case-not-found',
      'employee-tool-not-found',
      'employee-job-template-not-found',
    ] as const
    const zh = zhCN as unknown as {
      errorDomains: Record<string, string>
      errors: Record<string, string>
    }
    const en = enUS as unknown as {
      errorDomains: Record<string, string>
      errors: Record<string, string>
    }
    expect(zh.errorDomains.digitalEmployee).toBe('数字员工操作失败')
    expect(en.errorDomains.digitalEmployee).toBe('Digital employee action failed')
    for (const code of codes) {
      expect(typeof zh.errors[code], `zh ${code}`).toBe('string')
      expect(typeof en.errors[code], `en ${code}`).toBe('string')
      expect(zh.errors[code]!.length).toBeGreaterThan(0)
      expect(en.errors[code]!.length).toBeGreaterThan(0)
      // 两种语言各自成文，不是同一串复制。
      expect(zh.errors[code]).not.toBe(en.errors[code])
    }
  })
})
