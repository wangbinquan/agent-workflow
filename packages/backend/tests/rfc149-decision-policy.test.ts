// RFC-149 PR-1 — review 决策策略表 + 轮模式单一真源的回归锁。
//
// 为什么存在（design/RFC-149-review-decision-policy/design.md §1/§2/§4/§7）：
// submitReviewDecision 里 decision 一个字符串曾驱动 ≥13 个正交策略维（迭代
// bump / decisionReason 派生 / rerun-rollback 键名对 / supersede 列值+marker /
// mintCause / 级联语义 / lifecycle 事件），RFC-149 把它们收进
// REVIEW_DECISION_POLICY 单表。本文件锁四件事：
//   1. 三行表值逐字段钉死——尤其 rollbackDefault 的 reject=true / iterate=false
//      不对称（设计门 high 修订显式要求）。
//   2. resolveReviewRoundMode 三态判定格（空数组 / 混合 NULL 边界显式落格，
//      与旧 some/every NULL-sentinel 读取语义逐字等价）。
//   3. 决策分支棘轮：review.ts 剥注释后 `args.decision === '` 比较只允许出现在
//      两处路径骨架（multi-doc approve gate + approve 早返回）。任何策略维从表
//      里漏回散装 if 都会让本测试翻红。
//   4. decidedBy sentinel 治理（SYSTEM_DECIDER / LOCAL_DECIDER / isSystemDecision
//      谓词格）+ 发布口 oracle 常量与 reviewApprovedPortName 同源。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isSystemDecision,
  LOCAL_DECIDER,
  REVIEW_APPROVAL_META_PORT,
  REVIEW_APPROVED_PORT_MULTI,
  REVIEW_APPROVED_PORT_SINGLE,
  reviewApprovedPortName,
  SYSTEM_DECIDER,
} from '@agent-workflow/shared'
import { REVIEW_DECISION_POLICY, resolveReviewRoundMode } from '../src/services/review'

// ---------------------------------------------------------------------------
// 1. 策略表值锁
// ---------------------------------------------------------------------------

describe('REVIEW_DECISION_POLICY 表值锁', () => {
  test('approved：不 bump、approve-review、decisionReason=none、无 rerun 槽', () => {
    expect(REVIEW_DECISION_POLICY.approved).toEqual({
      bumpsIteration: false,
      lifecycleEvent: 'approve-review',
      decisionReason: 'none',
    })
    // 判别式表型：approved 禁 rerun 槽（编译期 { rerun?: never }，运行期无键）。
    expect('rerun' in REVIEW_DECISION_POLICY.approved).toBe(false)
  })

  test('rejected：bump、reject-review、reject-reason、rerun 六字段全量', () => {
    expect(REVIEW_DECISION_POLICY.rejected).toEqual({
      bumpsIteration: true,
      lifecycleEvent: 'reject-review',
      decisionReason: 'reject-reason',
      rerun: {
        rerunnableKey: 'rerunnableOnReject',
        rollbackKey: 'rollbackFilesOnReject',
        rollbackDefault: true,
        supersededByReview: 'rejected',
        mintCause: 'review-reject',
        cascade: 'always',
      },
    })
  })

  test('iterated：bump、iterate-review、render-comments、rerun 六字段全量', () => {
    expect(REVIEW_DECISION_POLICY.iterated).toEqual({
      bumpsIteration: true,
      lifecycleEvent: 'iterate-review',
      decisionReason: 'render-comments',
      rerun: {
        rerunnableKey: 'rerunnableOnIterate',
        rollbackKey: 'rollbackFilesOnIterate',
        rollbackDefault: false,
        supersededByReview: 'iterated',
        mintCause: 'review-iterate',
        cascade: 'sibling-sync-conditional',
      },
    })
  })

  test('rollbackDefault 不对称显式钉死：reject=true / iterate=false（设计门要求）', () => {
    expect(REVIEW_DECISION_POLICY.rejected.rerun.rollbackDefault).toBe(true)
    expect(REVIEW_DECISION_POLICY.iterated.rerun.rollbackDefault).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. resolveReviewRoundMode 三态格
// ---------------------------------------------------------------------------

describe('resolveReviewRoundMode 三态格（decision 侧唯一轮模式判据）', () => {
  test('空数组 → single（some 空数组边界；调用方在此之前已抛 review-doc-version-missing）', () => {
    expect(resolveReviewRoundMode([])).toBe('single')
  })

  test('全员 itemIndex NULL / undefined → single（单文档 NULL sentinel）', () => {
    expect(resolveReviewRoundMode([{ itemIndex: null, itemPath: null }])).toBe('single')
    expect(resolveReviewRoundMode([{}, {}])).toBe('single')
    expect(resolveReviewRoundMode([{ itemIndex: undefined, itemPath: 'docs/a.md' }])).toBe('single')
  })

  test('itemIndex 混 NULL → multi（some 语义：任一成员带 index 即 multi）', () => {
    expect(
      resolveReviewRoundMode([
        { itemIndex: null, itemPath: null },
        { itemIndex: 1, itemPath: null },
      ]),
    ).toBe('multi-inline')
  })

  test('itemIndex=0（falsy）也是 multi 成员', () => {
    expect(resolveReviewRoundMode([{ itemIndex: 0, itemPath: 'docs/a.md' }])).toBe('multi-path')
  })

  test('multi + 全员 itemPath NULL/undefined → multi-inline（RFC-081 inline 轮）', () => {
    expect(resolveReviewRoundMode([{ itemIndex: 0, itemPath: null }, { itemIndex: 1 }])).toBe(
      'multi-inline',
    )
  })

  test('multi + 任一 itemPath 非 NULL → multi-path（every 语义）', () => {
    expect(
      resolveReviewRoundMode([
        { itemIndex: 0, itemPath: null },
        { itemIndex: 1, itemPath: 'docs/b.md' },
      ]),
    ).toBe('multi-path')
    expect(
      resolveReviewRoundMode([
        { itemIndex: 0, itemPath: 'docs/a.md' },
        { itemIndex: 1, itemPath: 'docs/b.md' },
      ]),
    ).toBe('multi-path')
  })
})

// ---------------------------------------------------------------------------
// 3. 决策分支棘轮（源码级）
// ---------------------------------------------------------------------------

const REVIEW_SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'review.ts'),
  'utf8',
)

/** 行级剥注释（与 rfc145-error-message-machine-read-guard 同法）。 */
function stripCommentLines(content: string): string[] {
  return content.split('\n').map((line) => {
    const t = line.trim()
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : line
  })
}

describe('决策分支棘轮（args.decision 散装比较清零，白名单=路径骨架）', () => {
  const lines = stripCommentLines(REVIEW_SRC)

  test("args.decision === '…' 仅存两处骨架：multi-doc approve gate + approve 早返回", () => {
    const hits = lines.filter((l) => l.includes("args.decision === '")).map((l) => l.trim())
    // RFC-326 (design §6.1): the multi-doc gate reads the EFFECTIVE view — the
    // pending rows overlaid with the batch selections — hence `effectiveDvs`.
    expect(hits).toEqual([
      "if (isMultiDoc && args.decision === 'approved' && !allDocumentsDecided(effectiveDvs)) {",
      "if (args.decision === 'approved') {",
    ])
  })

  test('旧散装策略维的具体形态永不回潮', () => {
    expect(lines.filter((l) => l.includes('args.decision !==')).length).toBe(0)
    // 键名对三元 / marker 拼接 / mintCause 三元 / lifecycle 三元 / 广播 +0/+1：
    expect(REVIEW_SRC.includes("args.decision === 'rejected' ? 'rerunnableOnReject'")).toBe(false)
    expect(REVIEW_SRC.includes('REVIEW_SUPERSEDE_MARKER_PREFIX}${args.decision}')).toBe(false)
    expect(REVIEW_SRC.includes("args.decision === 'iterated' ? 'review-iterate'")).toBe(false)
    expect(REVIEW_SRC.includes("args.decision === 'iterated' ? { kind: 'iterate-review' }")).toBe(
      false,
    )
    expect(REVIEW_SRC.includes("args.decision === 'approved' ? 0 : 1")).toBe(false)
  })

  test('decidedBy / 发布口字面量清零（生产代码改引 shared 常量；注释可留）', () => {
    const prod = lines.join('\n')
    expect(prod.includes("'system'")).toBe(false)
    expect(prod.includes("'local'")).toBe(false)
    expect(prod.includes("'approved_doc'")).toBe(false)
    expect(prod.includes("'approval_meta'")).toBe(false)
    expect(prod.includes("portName: 'accepted'")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. decidedBy sentinel 治理 + 发布口 oracle 常量
// ---------------------------------------------------------------------------

describe('decidedBy sentinel 治理（RFC-149 §4）', () => {
  test('常量字节值（wire 不变）', () => {
    expect(SYSTEM_DECIDER).toBe('system')
    expect(LOCAL_DECIDER).toBe('local')
  })

  test('isSystemDecision 谓词格', () => {
    expect(isSystemDecision(SYSTEM_DECIDER)).toBe(true)
    expect(isSystemDecision('system')).toBe(true)
    expect(isSystemDecision(LOCAL_DECIDER)).toBe(false)
    expect(isSystemDecision('local')).toBe(false)
    expect(isSystemDecision(null)).toBe(false)
    expect(isSystemDecision(undefined)).toBe(false)
    expect(isSystemDecision('')).toBe(false)
    expect(isSystemDecision('01JXAMPLEULIDUSERIDXXXXXXX')).toBe(false)
    expect(isSystemDecision('SYSTEM')).toBe(false) // 大小写敏感——列值是精确字节
  })
})

describe('发布口 oracle 常量（RFC-149 §3）', () => {
  test('常量字节值与 reviewApprovedPortName 返回同源', () => {
    expect(REVIEW_APPROVED_PORT_SINGLE).toBe('approved_doc')
    expect(REVIEW_APPROVED_PORT_MULTI).toBe('accepted')
    expect(REVIEW_APPROVAL_META_PORT).toBe('approval_meta')
    expect(reviewApprovedPortName(undefined)).toBe(REVIEW_APPROVED_PORT_SINGLE)
    expect(reviewApprovedPortName('markdown')).toBe(REVIEW_APPROVED_PORT_SINGLE)
    expect(reviewApprovedPortName('path<md>')).toBe(REVIEW_APPROVED_PORT_SINGLE)
    expect(reviewApprovedPortName('list<path<md>>')).toBe(REVIEW_APPROVED_PORT_MULTI)
    expect(reviewApprovedPortName('list<markdown>')).toBe(REVIEW_APPROVED_PORT_MULTI)
  })
})
