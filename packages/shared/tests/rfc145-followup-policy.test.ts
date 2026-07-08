// RFC-145 T1 — FAILURE_CODES 枚举 + FOLLOWUP_POLICY 投影表 oracle。
//
// 为什么这条测试存在：信封失败的 follow-up 路由此前是 scheduler 里 7 连顺序敏感
// 的 errorMessage startsWith 链（flag-audit §4.3），生产侧 7 值与渲染侧 6 值的
// 多对一投影（clarify-forbidden→envelope-missing 降级）藏在链尾隐式分支里。本
// 测试把新单源锁死：
//   ① FAILURE_CODES 全集 7 值（生产域，与 node_runs.failure_code 列一致）；
//   ② FOLLOWUP_POLICY 覆盖全部 code（Record 编译期穷举 + 运行时 key 集自洽）；
//   ③ 投影语义逐格锁定——尤其 clarify-forbidden 的显式降级格（设计 D4）；
//   ④ reason 值域封闭在 EnvelopeFollowupReason 6 值内。
// 新增 failure code 时 Record 编译红逼填表；改投影必须过这里的逐格意图确认。

import { describe, expect, test } from 'bun:test'

import { FAILURE_CODES } from '../src/schemas/task'
import { SUPERSEDE_DECISIONS } from '../src/schemas/review'
import { FOLLOWUP_POLICY, type EnvelopeFollowupReason } from '../src/prompt'

const RENDER_REASONS: readonly EnvelopeFollowupReason[] = [
  'envelope-missing',
  'both-present',
  'clarify-malformed',
  'port-validation',
  'clarify-required',
  'envelope-port-malformed',
]

describe('RFC-145 FAILURE_CODES — 生产域全集', () => {
  test('7 值全集（顺序即文档顺序）', () => {
    expect([...FAILURE_CODES]).toEqual([
      'envelope-missing',
      'clarify-and-output-both',
      'clarify-questions-malformed',
      'clarify-required',
      'clarify-forbidden',
      'envelope-port-malformed',
      'port-validation-failed',
    ])
  })
})

describe('RFC-145 FOLLOWUP_POLICY — 7→6 投影表', () => {
  test('key 集与 FAILURE_CODES 完全自洽（防 Record 被 as-cast 绕过）', () => {
    expect(Object.keys(FOLLOWUP_POLICY).sort()).toEqual([...FAILURE_CODES].sort())
  })

  test('投影逐格锁定意图', () => {
    expect(FOLLOWUP_POLICY['envelope-missing'].reason).toBe('envelope-missing')
    expect(FOLLOWUP_POLICY['clarify-and-output-both'].reason).toBe('both-present')
    expect(FOLLOWUP_POLICY['clarify-questions-malformed'].reason).toBe('clarify-malformed')
    expect(FOLLOWUP_POLICY['clarify-required'].reason).toBe('clarify-required')
    // 设计 D4：曾经藏在 startsWith 链尾的隐式降级——stop 后再问的正确指令就是
    // 「现在给我 output 信封」，即 envelope-missing 文案。
    expect(FOLLOWUP_POLICY['clarify-forbidden'].reason).toBe('envelope-missing')
    expect(FOLLOWUP_POLICY['envelope-port-malformed'].reason).toBe('envelope-port-malformed')
    expect(FOLLOWUP_POLICY['port-validation-failed'].reason).toBe('port-validation')
  })

  test('reason 值域封闭在 6 值渲染域内；6 值均被至少一个 code 投影到（除非有意留空）', () => {
    const used = new Set(Object.values(FOLLOWUP_POLICY).map((p) => p.reason))
    for (const r of used) expect(RENDER_REASONS).toContain(r)
    // 当前 7→6 是满射：每个渲染 reason 都有生产来源。
    for (const r of RENDER_REASONS) expect(used.has(r)).toBe(true)
  })
})

describe('RFC-145 SUPERSEDE_DECISIONS — supersede 值域', () => {
  test('恰两值（approved 在标记代码前 early-return，永不 supersede）', () => {
    expect([...SUPERSEDE_DECISIONS]).toEqual(['iterated', 'rejected'])
  })
})
