// RFC-333 —— human-gate 请求的规范化形状（纯函数）。
//
// RFC-359 W4-D26：本文件原本还锁着 `SqliteHumanGateOperationStore` 的事务内记账语义；那份 store
// 已随手工提问写面合一而退役，它的逐条判据由**两个引擎各跑一遍**的
// `rfc359-t1-human-gate-journal.test.ts` 接管（同名的五条 + 恢复认领排序一条）。这里只留下与
// 引擎无关的规范化断言。

import { describe, expect, test } from 'bun:test'

import type { CanonicalHumanGateRequest } from '@/modules/collaboration/domain/canonicalGateRequest'
import {
  canonicalHumanGateJson,
  canonicalHumanGateRequestHash,
  deriveHumanGateCompatibilityKey,
} from '@/modules/collaboration/domain/canonicalGateRequest'

function request(overrides: Partial<CanonicalHumanGateRequest> = {}): CanonicalHumanGateRequest {
  return {
    schemaVersion: 1,
    taskId: 'task-333',
    gateKind: 'review',
    operationKind: 'decide',
    gateRef: 'review:node-a:iteration-1',
    actorUserId: 'user-a',
    expectedTaskRevision: 7,
    expectedGateRevision: 1,
    payload: {
      kind: 'review-decision',
      decision: 'approved',
      reviewIteration: 1,
      rejectReason: null,
      commentsJson: '[]',
      selectionsJson: '{}',
    },
    ...overrides,
  }
}

describe('RFC-333 canonical human-gate request', () => {
  test('sorts object keys, preserves array order, and binds actor plus revisions', () => {
    const first = request()
    const reordered = {
      payload: {
        selectionsJson: '{}',
        commentsJson: '[]',
        rejectReason: null,
        reviewIteration: 1,
        decision: 'approved',
        kind: 'review-decision',
      },
      expectedGateRevision: 1,
      expectedTaskRevision: 7,
      actorUserId: 'user-a',
      gateRef: 'review:node-a:iteration-1',
      operationKind: 'decide',
      gateKind: 'review',
      taskId: 'task-333',
      schemaVersion: 1,
    } as const satisfies CanonicalHumanGateRequest

    expect(canonicalHumanGateJson(reordered)).toBe(canonicalHumanGateJson(first))
    expect(canonicalHumanGateRequestHash(reordered)).toBe(canonicalHumanGateRequestHash(first))
    expect(
      canonicalHumanGateRequestHash(
        request({
          gateKind: 'questions',
          gateRef: 'questions:round-1',
          payload: { kind: 'question-dispatch', entryIds: ['a', 'b'] },
        }),
      ),
    ).not.toBe(
      canonicalHumanGateRequestHash(
        request({
          gateKind: 'questions',
          gateRef: 'questions:round-1',
          payload: { kind: 'question-dispatch', entryIds: ['b', 'a'] },
        }),
      ),
    )
    expect(canonicalHumanGateRequestHash(request({ actorUserId: 'user-b' }))).not.toBe(
      canonicalHumanGateRequestHash(first),
    )
    expect(canonicalHumanGateRequestHash(request({ expectedGateRevision: 2 }))).not.toBe(
      canonicalHumanGateRequestHash(first),
    )
    expect(deriveHumanGateCompatibilityKey(request({ actorUserId: null }))).not.toBe(
      deriveHumanGateCompatibilityKey(first),
    )
  })
})
