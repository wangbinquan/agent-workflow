// flag-audit W0（design/flag-audit-2026-07-07.md §4.2）——wrapper（容器）kind
// 判定单源化的回归锁。收口前该成员集以 or-chain / 私有 Set 的形式在三个包手抄
// ~20 处，RFC-060 加 wrapper-fanout 时就漏改过 canvas coordProjection（wrapper
// 渲染尺寸 bug）。本文件锁：
//   1. WRAPPER_NODE_KINDS 的派生性质——它恰好等于 NODE_KIND 里所有 'wrapper-'
//      前缀的 kind（新增 wrapper kind 忘登记 / 登记了非 wrapper kind 都会红）。
//   2. isWrapperKind 对字符串宽容（xyflow node.type 是 string|undefined）。
//   3. 曾经手抄成员集的重灾区文件不得再出现三连字面量并集（防 re-fork）。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { NODE_KIND, WRAPPER_NODE_KINDS, isWrapperKind } from '../src/schemas/workflow'

const REPO = resolve(import.meta.dir, '..', '..', '..')

describe('WRAPPER_NODE_KINDS 单源（flag-audit W0）', () => {
  test('成员 = NODE_KIND 中全部 wrapper- 前缀 kind（派生性质锁）', () => {
    const derived = NODE_KIND.filter((k) => k.startsWith('wrapper-'))
    expect([...WRAPPER_NODE_KINDS].sort()).toEqual([...derived].sort())
  })

  test('isWrapperKind 判定 + 字符串/空值宽容', () => {
    expect(isWrapperKind('wrapper-git')).toBe(true)
    expect(isWrapperKind('wrapper-loop')).toBe(true)
    expect(isWrapperKind('wrapper-fanout')).toBe(true)
    expect(isWrapperKind('agent-single')).toBe(false)
    expect(isWrapperKind(undefined)).toBe(false)
    expect(isWrapperKind(null)).toBe(false)
    expect(isWrapperKind('')).toBe(false)
  })

  test('重灾区文件不得再手抄三连并集（防 re-fork 源码锁）', () => {
    // 三连字面量并集（=== 或 !== 均算）曾经的宿主文件。isWrapperKind/
    // WRAPPER_NODE_KINDS 是唯一合法出口；单 kind 判断（=== 'wrapper-git'）
    // 与刻意的 git/loop 二连（fanout 语义不同的规则）不在此锁范围。
    const files = [
      'packages/shared/src/workflow-sync-diff.ts',
      'packages/backend/src/services/dispatchFrontier.ts',
      'packages/backend/src/services/scheduler.ts',
      'packages/backend/src/services/workflow.validator.ts',
      'packages/frontend/src/components/canvas/WorkflowCanvas.tsx',
      'packages/frontend/src/components/canvas/coordProjection.ts',
      'packages/frontend/src/components/canvas/wrapperOps.ts',
      'packages/frontend/src/components/canvas/wrapperFit.ts',
      'packages/frontend/src/components/canvas/wrapperMembership.ts',
      'packages/frontend/src/components/canvas/wrapperCandidates.ts',
    ]
    const tripleUnion =
      /kind\s*[!=]==\s*'wrapper-(git|loop|fanout)'\s*(\|\||&&)\s*[^\n]*kind\s*[!=]==\s*'wrapper-(git|loop|fanout)'\s*(\|\||&&)\s*[^\n]*kind\s*[!=]==\s*'wrapper-(git|loop|fanout)'/s
    for (const rel of files) {
      const src = readFileSync(resolve(REPO, rel), 'utf8')
      expect(tripleUnion.test(src), `${rel} re-forked the wrapper triple union`).toBe(false)
    }
  })
})
