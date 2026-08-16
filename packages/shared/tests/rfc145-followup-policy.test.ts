// RFC-145 T1 — FOLLOWUP_FAILURE_CODES 枚举 + FOLLOWUP_POLICY 投影表 oracle。
//
// RFC-306 起：生产域 7→9（新增两条分支标记违规），渲染域 6→7（新增 'branch-marker'）。
// 两条生产码投到同一个渲染 reason 是刻意的——「标错了端口」与「active 值非法」的
// 修法完全相同（改标记后重发信封），给它们两套文案只会让 agent 多读一段无差别的话。
//
// 为什么这条测试存在：信封失败的 follow-up 路由此前是 scheduler 里 7 连顺序敏感
// 的 errorMessage startsWith 链（flag-audit §4.3），生产侧 7 值与渲染侧 6 值的
// 多对一投影（clarify-forbidden→envelope-missing 降级）藏在链尾隐式分支里。本
// 测试把新单源锁死：
//   ① FOLLOWUP_FAILURE_CODES 全集 7 值（可修复的信封协议生产域）；
//   ② FOLLOWUP_POLICY 覆盖全部 code（Record 编译期穷举 + 运行时 key 集自洽）；
//   ③ 投影语义逐格锁定——尤其 clarify-forbidden 的显式降级格（设计 D4）；
//   ④ reason 值域封闭在 EnvelopeFollowupReason 6 值内。
// 新增 failure code 时 Record 编译红逼填表；改投影必须过这里的逐格意图确认。

import { describe, expect, test } from 'bun:test'

import { FOLLOWUP_FAILURE_CODES } from '../src/schemas/task'
import { SUPERSEDE_DECISIONS } from '../src/schemas/review'
import { FOLLOWUP_POLICY, type EnvelopeFollowupReason } from '../src/prompt'

const RENDER_REASONS: readonly EnvelopeFollowupReason[] = [
  'envelope-missing',
  'both-present',
  'clarify-malformed',
  'port-validation',
  'clarify-required',
  'envelope-port-malformed',
  // RFC-306：信封本身合法，但分支标记非法（端口未声明为分支端口 / active 值非法）。
  'branch-marker',
]

describe('RFC-145 FOLLOWUP_FAILURE_CODES — 可修复协议失败窄域全集', () => {
  test('9 值全集（顺序即文档顺序）', () => {
    expect([...FOLLOWUP_FAILURE_CODES]).toEqual([
      'envelope-missing',
      'clarify-and-output-both',
      'clarify-questions-malformed',
      'clarify-required',
      'clarify-forbidden',
      'envelope-port-malformed',
      'port-validation-failed',
      // RFC-306：可 follow-up 是刻意的——agent 表达了一个真实意图（不要跑这条分支），
      // 只是用在了承载不了它的端口上，一次同 session 纠正通常就能修好；
      // 反过来「当作激活处理」会让它以为关掉的分支照跑，是这套机制最坏的结果。
      'branch-port-not-declared',
      'branch-marker-malformed',
    ])
  })
})

describe('RFC-145 FOLLOWUP_POLICY — 9→7 投影表', () => {
  test('key 集与 FOLLOWUP_FAILURE_CODES 完全自洽（identity 失败不得混入）', () => {
    expect(Object.keys(FOLLOWUP_POLICY).sort()).toEqual([...FOLLOWUP_FAILURE_CODES].sort())
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
    // RFC-306：两条生产码 → 同一渲染 reason（修法相同，见文件头注）。
    expect(FOLLOWUP_POLICY['branch-port-not-declared'].reason).toBe('branch-marker')
    expect(FOLLOWUP_POLICY['branch-marker-malformed'].reason).toBe('branch-marker')
  })

  test('reason 值域封闭在 7 值渲染域内；7 值均被至少一个 code 投影到（除非有意留空）', () => {
    const used = new Set(Object.values(FOLLOWUP_POLICY).map((p) => p.reason))
    for (const r of used) expect(RENDER_REASONS).toContain(r)
    // 当前 9→7 仍是满射：每个渲染 reason 都有生产来源。
    for (const r of RENDER_REASONS) expect(used.has(r)).toBe(true)
  })
})

describe('RFC-145 SUPERSEDE_DECISIONS — supersede 值域', () => {
  test('恰两值（approved 在标记代码前 early-return，永不 supersede）', () => {
    expect([...SUPERSEDE_DECISIONS]).toEqual(['iterated', 'rejected'])
  })
})
