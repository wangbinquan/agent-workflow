// LOCKS: RFC-325 —— 平台下拉框搜索的单一匹配实现（lib/option-search.ts）。
//
// 这两个纯函数是 Select / MultiSelect / user-permissions 三处共用的可断言面：
// 「全角能不能搜到半角」「描述算不算可搜」「多词会不会跨字段乱命中」在这里一次定死，
// 免得再像 RFC-325 之前那样，同一个平台里同一个问题有四个答案。

import { describe, expect, test } from 'vitest'
import { matchesSearchQuery, normalizeSearchText } from '../src/lib/option-search'

describe('normalizeSearchText (RFC-325)', () => {
  test('NFKC 折叠全角与半角', () => {
    expect(normalizeSearchText('ＡＢＣ')).toBe('abc')
    expect(normalizeSearchText('ｇｐｔ－４')).toBe('gpt-4')
  })

  test('大小写不敏感', () => {
    expect(normalizeSearchText('Code Reviewer')).toBe('code reviewer')
  })

  test('连续空白折叠为单空格并 trim', () => {
    expect(normalizeSearchText('  a \n\t b  ')).toBe('a b')
  })

  test('中文原样保留（只做小写与空白折叠）', () => {
    expect(normalizeSearchText(' 财务  审核 ')).toBe('财务 审核')
  })

  test('locale 参与小写折叠', () => {
    // 传入 locale 不改变本仓 zh-CN / en-US 的结果；这里只锁「参数被透传、不抛错」。
    expect(normalizeSearchText('ABC', 'zh-CN')).toBe('abc')
    expect(normalizeSearchText('ABC', 'en-US')).toBe('abc')
  })

  test('空串安全', () => {
    expect(normalizeSearchText('')).toBe('')
    expect(normalizeSearchText('   ')).toBe('')
  })
})

describe('matchesSearchQuery (RFC-325)', () => {
  test('空 / 全空白查询恒真', () => {
    expect(matchesSearchQuery(['anything'], '')).toBe(true)
    expect(matchesSearchQuery(['anything'], '   ')).toBe(true)
    expect(matchesSearchQuery([], '')).toBe(true)
  })

  test('任一字段命中即真', () => {
    const fields = ['Code Reviewer', 'reviewer', '审阅代码变更', 'anthropic']
    expect(matchesSearchQuery(fields, 'code')).toBe(true)
    expect(matchesSearchQuery(fields, 'reviewer')).toBe(true)
    expect(matchesSearchQuery(fields, '审阅')).toBe(true)
    expect(matchesSearchQuery(fields, 'anthropic')).toBe(true)
    expect(matchesSearchQuery(fields, 'zzz')).toBe(false)
  })

  test('全角查询命中半角内容（两侧同一归一化）', () => {
    expect(matchesSearchQuery(['gpt-4'], 'ＧＰＴ－４')).toBe(true)
    expect(matchesSearchQuery(['ＧＰＴ－４'], 'gpt-4')).toBe(true)
  })

  test('逐字段语义：多词不跨字段命中', () => {
    // label = 'alpha'、description = 'beta'：拼成一个 haystack 会让 'alpha beta'
    // 命中，用户看着那一行看不出为什么。逐字段实现必须判否。
    expect(matchesSearchQuery(['alpha', 'beta'], 'alpha beta')).toBe(false)
    expect(matchesSearchQuery(['alpha beta'], 'alpha beta')).toBe(true)
  })

  test('undefined / null / 空串字段安全跳过', () => {
    expect(matchesSearchQuery(['label', undefined, null, ''], 'label')).toBe(true)
    expect(matchesSearchQuery([undefined, null, ''], 'label')).toBe(false)
  })

  test('查询词自身的多余空白被折叠', () => {
    expect(matchesSearchQuery(['code reviewer'], '  code   reviewer  ')).toBe(true)
  })
})
