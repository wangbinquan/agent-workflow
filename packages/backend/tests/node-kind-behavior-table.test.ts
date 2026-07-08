// RFC-053 P-2 / RFC-146 — NODE_KIND_BEHAVIORS 全真行为表锁。
//
// 为什么这条测试存在：RFC-053 的原表五维只有 retryCascade 被运行时消费，其余
// 四维（limits/orphanReap/gc/shutdown）是「愿望文档」假 SSOT（flag-audit §4.2）。
// RFC-146 重铸后表的准入标准 = 每一维都有 grep 可证的运行时消费者：
//   retryCascade → services/task.ts retryNode 级联；
//   isProcess → isProcessNodeKind（表化后单源，历史 or-chain 孪生已删）；
//   isAgent → isAgentNodeKind（收敛 5 处 agent-single 判定）；
//   settlesWithoutRow → scheduler SETTLES_WITHOUT_ROW 派生 + stuckTaskDetector。
// 本文件锁：①逐 kind × 逐维值（意图确认）；②key 全集与 NODE_KIND 自洽；
// ③三个派生谓词与表引用同源（不再是「巧合等价靠测试对齐」）；④四个愿望维
// 确已删除（防回潮）。

import { describe, expect, test } from 'bun:test'
import {
  NODE_KIND,
  NODE_KIND_BEHAVIORS,
  isAgentNodeKind,
  isProcessNodeKind,
  isWrapperKind,
  nodeKindParticipatesInRetryCascade,
  nodeKindSettlesWithoutRow,
  type NodeKind,
} from '@agent-workflow/shared'

describe('RFC-146 NODE_KIND_BEHAVIORS — 全真表', () => {
  test('key 全集与 NODE_KIND 完全自洽', () => {
    expect(Object.keys(NODE_KIND_BEHAVIORS).sort()).toEqual([...NODE_KIND].sort())
  })

  test('逐 kind × 逐维值锁（意图确认——改表须过这里）', () => {
    const expectRow = (
      kind: NodeKind,
      row: {
        retryCascade: 'mint-placeholder' | 'skip'
        isProcess: boolean
        isAgent: boolean
        settlesWithoutRow: boolean
      },
    ) => expect(NODE_KIND_BEHAVIORS[kind] as unknown).toEqual(row)

    expectRow('agent-single', {
      retryCascade: 'mint-placeholder',
      isProcess: true,
      isAgent: true,
      settlesWithoutRow: false,
    })
    for (const k of ['wrapper-git', 'wrapper-loop', 'wrapper-fanout'] as const) {
      expectRow(k, {
        retryCascade: 'mint-placeholder',
        isProcess: true,
        isAgent: false,
        settlesWithoutRow: false,
      })
    }
    expectRow('review', {
      retryCascade: 'skip',
      isProcess: false,
      isAgent: false,
      settlesWithoutRow: false,
    })
    for (const k of ['clarify', 'clarify-cross-agent'] as const) {
      expectRow(k, {
        retryCascade: 'skip',
        isProcess: false,
        isAgent: false,
        settlesWithoutRow: true,
      })
    }
    for (const k of ['input', 'output'] as const) {
      expectRow(k, {
        retryCascade: 'skip',
        isProcess: false,
        isAgent: false,
        settlesWithoutRow: false,
      })
    }
  })

  test('派生谓词与表引用同源（逐 kind property）', () => {
    for (const k of NODE_KIND) {
      expect(isProcessNodeKind(k)).toBe(NODE_KIND_BEHAVIORS[k].isProcess)
      expect(isAgentNodeKind(k)).toBe(NODE_KIND_BEHAVIORS[k].isAgent)
      expect(nodeKindSettlesWithoutRow(k)).toBe(NODE_KIND_BEHAVIORS[k].settlesWithoutRow)
      expect(nodeKindParticipatesInRetryCascade(k)).toBe(
        NODE_KIND_BEHAVIORS[k].retryCascade === 'mint-placeholder',
      )
    }
  })

  test('结构关系：isAgent ⊂ isProcess；isProcess = agent ∪ wrapper；settlesWithoutRow ∩ isProcess = ∅', () => {
    for (const k of NODE_KIND) {
      const row = NODE_KIND_BEHAVIORS[k]
      if (row.isAgent) expect(row.isProcess).toBe(true)
      expect(row.isProcess).toBe(row.isAgent || isWrapperKind(k))
      if (row.settlesWithoutRow) expect(row.isProcess).toBe(false)
      // RFC-052 语义：级联恰是 process 家族。
      expect(row.retryCascade === 'mint-placeholder').toBe(row.isProcess)
    }
  })

  test('四个愿望维已删除（防回潮——表准入标准 = 有运行时消费者）', () => {
    for (const k of NODE_KIND) {
      const row = NODE_KIND_BEHAVIORS[k] as Record<string, unknown>
      expect(row.limits).toBeUndefined()
      expect(row.orphanReap).toBeUndefined()
      expect(row.gc).toBeUndefined()
      expect(row.shutdown).toBeUndefined()
      expect(Object.keys(row).sort()).toEqual([
        'isAgent',
        'isProcess',
        'retryCascade',
        'settlesWithoutRow',
      ])
    }
  })
})
