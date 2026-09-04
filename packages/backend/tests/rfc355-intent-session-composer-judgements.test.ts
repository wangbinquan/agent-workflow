// RFC-355 T8（实现门 r2 findings）—— 会话详情里三处用户可见判据的预言力。
//
// 为什么这些用例存在：实现门第二路对这三处做变异实验，**全部零预言力**——
// `retrySource` 三个方向、`composerSource` 的 `conversation` 档、
// `latestAgentTurn` 取最新还是取最早，改错了 1122 条 intent + contract 测试无一变红。
// 它们当时是 `sessionDetail.ts` 里的内联表达式，只能靠「起一整个 HTTP harness 并恰好
// 断言到那个字段」来覆盖，而实测那种覆盖并不存在。
//
// 现在判据在 `domain/sessionComposer.ts`，每一档单独钉死。

import { describe, expect, test } from 'bun:test'
import {
  hasApprovalAfterLatestAgentTurn,
  intentComposerSourceOf,
  intentRetrySourceOf,
  latestIntentAgentTurnOf,
} from '../src/modules/intent/domain/sessionComposer'

const turn = (seq: number, role: string, kind: string) => ({ id: `t${seq}`, seq, role, kind })

describe('RFC-355 —— 最新的一条 agent 轮次', () => {
  test('取**最新**不是最早——这一个值同时喂重试入口 / 挂载建议 / journey 三处', () => {
    const turns = [
      turn(1, 'agent', 'message'),
      turn(2, 'user', 'message'),
      turn(3, 'agent', 'error'),
    ]
    expect(latestIntentAgentTurnOf(turns)?.seq).toBe(3)
  })

  test('跳过非 agent 轮次', () => {
    expect(latestIntentAgentTurnOf([turn(1, 'agent', 'x'), turn(2, 'user', 'y')])?.seq).toBe(1)
  })

  test('一条 agent 轮次都没有 ⇒ undefined（不是抛，也不是拿 user 那条顶）', () => {
    expect(latestIntentAgentTurnOf([turn(1, 'user', 'message')])).toBeUndefined()
    expect(latestIntentAgentTurnOf([])).toBeUndefined()
  })

  test('不改动入参数组（详情编排后面还要按原序用它）', () => {
    const turns = [turn(1, 'agent', 'a'), turn(2, 'agent', 'b')]
    latestIntentAgentTurnOf(turns)
    expect(turns.map((t) => t.seq)).toEqual([1, 2])
  })
})

describe('RFC-355 —— 最新 agent 轮次之后有没有批过挂载', () => {
  const latest = turn(5, 'agent', 'questions')

  test('之后有 mount-approval ⇒ true', () => {
    expect(
      hasApprovalAfterLatestAgentTurn([latest, turn(6, 'user', 'mount-approval')], latest),
    ).toBe(true)
  })

  test('审批在**之前** ⇒ false（那是上一轮批的，与这一轮无关）', () => {
    expect(
      hasApprovalAfterLatestAgentTurn([turn(4, 'user', 'mount-approval'), latest], latest),
    ).toBe(false)
  })

  test('同一个 seq 不算「之后」', () => {
    expect(hasApprovalAfterLatestAgentTurn([{ ...latest, kind: 'mount-approval' }], latest)).toBe(
      false,
    )
  })

  test('没有 agent 轮次 ⇒ false', () => {
    expect(hasApprovalAfterLatestAgentTurn([turn(1, 'user', 'mount-approval')], undefined)).toBe(
      false,
    )
  })
})

describe('RFC-355 —— 编辑器以什么为底（三档）', () => {
  test('有当前草稿 ⇒ current-draft，且带上 draftId / revision', () => {
    expect(
      intentComposerSourceOf({ currentDraft: { id: 'd1', revision: 3 }, commitSeq: 9 }),
    ).toEqual({
      kind: 'current-draft',
      draftId: 'd1',
      revision: 3,
    })
  })

  test('无草稿但提交过 ⇒ latest-checkpoint（前端据此显示「基于上次提交继续」）', () => {
    expect(intentComposerSourceOf({ currentDraft: null, commitSeq: 1 })).toEqual({
      kind: 'latest-checkpoint',
      commitSeq: 1,
    })
  })

  test('无草稿也没提交过 ⇒ conversation——这一档实现门实测此前零覆盖', () => {
    expect(intentComposerSourceOf({ currentDraft: null, commitSeq: 0 })).toEqual({
      kind: 'conversation',
    })
  })

  test('commitSeq 的分界是 > 0，不是 >= 0', () => {
    expect(intentComposerSourceOf({ currentDraft: null, commitSeq: 0 }).kind).toBe('conversation')
    expect(intentComposerSourceOf({ currentDraft: null, commitSeq: 1 }).kind).toBe(
      'latest-checkpoint',
    )
  })
})

describe('RFC-355 —— 「重试上一轮」入口的两个守卫', () => {
  const errored = turn(7, 'agent', 'error')

  test('上一轮是 error 且没有轮次在飞 ⇒ 给入口', () => {
    expect(intentRetrySourceOf({ latestAgentTurn: errored, inFlightTurnId: null })).toEqual({
      turnId: 't7',
      turnSeq: 7,
    })
  })

  test('生成还在飞 ⇒ 不给（点下去会撞 in-flight 冲突）', () => {
    expect(intentRetrySourceOf({ latestAgentTurn: errored, inFlightTurnId: 'turn-x' })).toBeNull()
  })

  test.each(['message', 'questions', 'changeset', 'running', 'answers', 'mount-approval'])(
    '上一轮是 %s（不是 error）⇒ 不给（成功的轮次没什么可重试）',
    (kind) => {
      expect(
        intentRetrySourceOf({ latestAgentTurn: turn(7, 'agent', kind), inFlightTurnId: null }),
      ).toBeNull()
    },
  )

  test('一条 agent 轮次都没有 ⇒ 不给', () => {
    expect(intentRetrySourceOf({ latestAgentTurn: undefined, inFlightTurnId: null })).toBeNull()
  })
})
