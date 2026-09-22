// RFC-368 T1–T3 —— Reaction 执行合同的三组纯判据。
//
// 这三支是本 RFC 的可断言面（design.md §8「纯函数优先」）：请求工厂、裁剪规则、两套重试判据。
// 其中**两套重试判据必须与改造前逐值相等**（AC-8）——设计门 r1 的 P1-7 就是因为初稿只认识
// round 级那一套，把派发级整条丢了（后果：launch 永久失败的 round 会无限重试、案例永不终结）。
// 所以下面的 parity 用例把改造前的算术**原样抄了一份**当预言，两边逐值对拍。

import { describe, expect, test } from 'bun:test'

import { retryAttemptCap } from '@/platform/contracts/retryAttemptCap'
import {
  attemptModeForOrdinal,
  dispatchRetrySchedule,
  roundRetrySchedule,
  type ReactionAttemptMode,
  type ReactionRetryPolicyV1,
} from '@/modules/digital-employee/domain/retrySchedule'
import {
  REACTION_ARTIFACT_MAX_CHARS,
  parseReactionArtifactRef,
  reactionArtifactRef,
  sanitizeReactionText,
} from '@/modules/digital-employee/domain/reactionArtifacts'
import {
  prepareReactionExecution,
  reactionOperationRef,
  reactionRequestHash,
} from '@/modules/digital-employee/domain/reactionExecutionRequest'

const POLICY: ReactionRetryPolicyV1 = {
  sameSceneAttempts: 2,
  freshSceneAttempts: 1,
  initialBackoffMs: 1_000,
  maxBackoffMs: 60_000,
}

describe('RFC-368 T3 —— round 级重试判据与改造前逐值相等', () => {
  // 改造前的算术，原样抄自 `application/runtimeService.ts` 的 `#retryOrFailExecution`
  // （nextOrdinal / retryBudget / mode / retryDelay 四段）。这是预言，不是实现。
  function legacyRoundDecision(
    attemptOrdinal: number,
    boundaryFailure: boolean,
    policy: ReactionRetryPolicyV1,
  ): { retry: boolean; nextOrdinal: number; mode: ReactionAttemptMode; delayMs: number } {
    const attemptsPerScene = policy.sameSceneAttempts + 1
    const nextOrdinal = boundaryFailure
      ? Math.max(
          attemptOrdinal + 1,
          (Math.floor(attemptOrdinal / attemptsPerScene) + 1) * attemptsPerScene,
        )
      : attemptOrdinal + 1
    const retryBudget = retryAttemptCap(policy.sameSceneAttempts, policy.freshSceneAttempts) - 1
    if (nextOrdinal > retryBudget)
      return { retry: false, nextOrdinal, mode: 'same-scene', delayMs: 0 }
    return {
      retry: true,
      nextOrdinal,
      mode: nextOrdinal % attemptsPerScene === 0 ? 'fresh-scene' : 'same-scene',
      delayMs: Math.min(
        policy.maxBackoffMs,
        policy.initialBackoffMs * 2 ** Math.max(0, nextOrdinal - 1),
      ),
    }
  }

  test('整个预算区间逐值对拍（含边界失败升级到下一场景边界）', () => {
    const policies: ReactionRetryPolicyV1[] = [
      POLICY,
      { sameSceneAttempts: 0, freshSceneAttempts: 0, initialBackoffMs: 0, maxBackoffMs: 0 },
      { sameSceneAttempts: 1, freshSceneAttempts: 3, initialBackoffMs: 500, maxBackoffMs: 4_000 },
      {
        sameSceneAttempts: 3,
        freshSceneAttempts: 2,
        initialBackoffMs: 1_000,
        maxBackoffMs: 60_000,
      },
    ]
    for (const policy of policies) {
      for (let ordinal = 0; ordinal <= 20; ordinal += 1) {
        for (const boundaryFailure of [false, true]) {
          expect({
            ordinal,
            boundaryFailure,
            ...roundRetrySchedule({ attemptOrdinal: ordinal, boundaryFailure, policy }),
          }).toEqual({
            ordinal,
            boundaryFailure,
            ...legacyRoundDecision(ordinal, boundaryFailure, policy),
          })
        }
      }
    }
  })

  test('退避封顶在 maxBackoffMs，不会随 ordinal 无限翻倍', () => {
    expect(
      roundRetrySchedule({ attemptOrdinal: 0, boundaryFailure: false, policy: POLICY }).delayMs,
    ).toBe(1_000)
    expect(
      roundRetrySchedule({ attemptOrdinal: 1, boundaryFailure: false, policy: POLICY }).delayMs,
    ).toBe(2_000)
    const capped = { ...POLICY, maxBackoffMs: 1_500 }
    expect(
      roundRetrySchedule({ attemptOrdinal: 1, boundaryFailure: false, policy: capped }).delayMs,
    ).toBe(1_500)
  })

  test('预算耗尽后不再重试', () => {
    const budget = retryAttemptCap(POLICY.sameSceneAttempts, POLICY.freshSceneAttempts) - 1
    expect(
      roundRetrySchedule({ attemptOrdinal: budget - 1, boundaryFailure: false, policy: POLICY })
        .retry,
    ).toBe(true)
    expect(
      roundRetrySchedule({ attemptOrdinal: budget, boundaryFailure: false, policy: POLICY }).retry,
    ).toBe(false)
  })
})

describe('RFC-368 T3 —— 派发级重试判据与改造前逐值相等', () => {
  // 改造前的算术，原样抄自 `runOneOutbox` 的 catch（maxAttempts / terminal / backoff 三行）。
  // 注意它与 round 级用的是**不同的计数器和不同的上界**：这里是 `attemptCount >= max(1, cap)`，
  // 那边是 `nextOrdinal > cap - 1`。差一位是历史事实，不是笔误。
  function legacyDispatchDecision(
    dispatchAttempts: number,
    limitReached: boolean,
    policy: ReactionRetryPolicyV1 | null,
  ): { terminal: boolean; delayMs: number } {
    const maxAttempts = retryAttemptCap(
      policy?.sameSceneAttempts ?? 1,
      policy?.freshSceneAttempts ?? 1,
    )
    const initial = policy?.initialBackoffMs ?? 1_000
    const maximum = policy?.maxBackoffMs ?? 60_000
    return {
      terminal: limitReached || dispatchAttempts >= Math.max(1, maxAttempts),
      delayMs: Math.min(maximum, initial * 2 ** Math.max(0, dispatchAttempts - 1)),
    }
  }

  test('整个区间逐值对拍，含 policy 缺席时的字面缺省（1/1/1000/60000）', () => {
    for (const policy of [
      POLICY,
      null,
      { sameSceneAttempts: 0, freshSceneAttempts: 0, initialBackoffMs: 250, maxBackoffMs: 1_000 },
    ]) {
      for (let attempts = 0; attempts <= 20; attempts += 1) {
        for (const limitReached of [false, true]) {
          expect({
            attempts,
            limitReached,
            ...dispatchRetrySchedule({ dispatchAttempts: attempts, limitReached, policy }),
          }).toEqual({
            attempts,
            limitReached,
            ...legacyDispatchDecision(attempts, limitReached, policy),
          })
        }
      }
    }
  })

  test('派发预算耗尽后必然终结——不会无限重试（设计门 P1-7 锁的就是这条）', () => {
    const cap = Math.max(1, retryAttemptCap(POLICY.sameSceneAttempts, POLICY.freshSceneAttempts))
    expect(
      dispatchRetrySchedule({ dispatchAttempts: cap - 1, limitReached: false, policy: POLICY })
        .terminal,
    ).toBe(false)
    expect(
      dispatchRetrySchedule({ dispatchAttempts: cap, limitReached: false, policy: POLICY })
        .terminal,
    ).toBe(true)
  })

  test('两套判据确实不同——同一个计数值上结论可以相反', () => {
    const at = 1
    expect(
      roundRetrySchedule({ attemptOrdinal: at, boundaryFailure: false, policy: POLICY }).retry,
    ).toBe(true)
    const tight: ReactionRetryPolicyV1 = { ...POLICY, sameSceneAttempts: 0, freshSceneAttempts: 0 }
    expect(
      dispatchRetrySchedule({ dispatchAttempts: at, limitReached: false, policy: tight }).terminal,
    ).toBe(true)
  })
})

describe('RFC-368 T3 —— 在途迁移的 mode 重算', () => {
  test('ordinal 0 是 initial，场景边界上是 fresh-scene，其余 same-scene', () => {
    expect(attemptModeForOrdinal(0, 2)).toBe('initial')
    expect(attemptModeForOrdinal(1, 2)).toBe('same-scene')
    expect(attemptModeForOrdinal(2, 2)).toBe('same-scene')
    expect(attemptModeForOrdinal(3, 2)).toBe('fresh-scene')
    expect(attemptModeForOrdinal(6, 2)).toBe('fresh-scene')
  })
})

describe('RFC-368 T2 —— 反馈裁剪的五条规则', () => {
  const root = '/Users/someone/.agent-workflow/worktrees/repo/task-1'

  test('R1：errorCode 原样保留', () => {
    expect(
      sanitizeReactionText({
        errorCode: 'execution-envelope-invalid',
        errorDetail: 'x',
        workspaceRoot: null,
      }).body,
    ).toBe('execution-envelope-invalid: x')
  })

  test('R2：工作区绝对路径改写成相对路径', () => {
    const { body } = sanitizeReactionText({
      errorCode: 'e',
      errorDetail: `cannot read ${root}/src/app.ts`,
      workspaceRoot: root,
    })
    expect(body).toBe('e: cannot read src/app.ts')
  })

  test('R2 反例：工作区之外的路径不动', () => {
    const { body } = sanitizeReactionText({
      errorCode: 'e',
      errorDetail: '/etc/hosts is unreadable',
      workspaceRoot: root,
    })
    expect(body).toBe('e: /etc/hosts is unreadable')
  })

  test('R3：栈帧行整行丢弃（用户 2026-09-22 裁决）', () => {
    const { body } = sanitizeReactionText({
      errorCode: 'e',
      errorDetail: 'boom\n    at parse (/a/b.ts:1:2)\n    at run (/a/c.ts:3:4)',
      workspaceRoot: null,
    })
    expect(body).toBe('e: boom')
  })

  test('R3 反例：正文里以 at 开头的**句子**不算栈帧，不能被丢掉', () => {
    const { body } = sanitizeReactionText({
      errorCode: 'e',
      errorDetail: 'atomic write failed\nattempted three times',
      workspaceRoot: null,
    })
    expect(body).toBe('e: atomic write failed\nattempted three times')
  })

  test('R4：连续重复行折叠', () => {
    const { body } = sanitizeReactionText({
      errorCode: 'e',
      errorDetail: 'retrying\nretrying\nretrying\ndone',
      workspaceRoot: null,
    })
    expect(body).toBe('e: retrying (× 3)\ndone')
  })

  test('R4 反例：不相邻的重复行各自保留', () => {
    const { body } = sanitizeReactionText({
      errorCode: 'e',
      errorDetail: 'a\nb\na',
      workspaceRoot: null,
    })
    expect(body).toBe('e: a\nb\na')
  })

  test('R5：裁剪后仍超长则截断到 4000', () => {
    const { body } = sanitizeReactionText({
      errorCode: 'e',
      errorDetail: 'x'.repeat(10_000),
      workspaceRoot: null,
    })
    expect(body).toHaveLength(REACTION_ARTIFACT_MAX_CHARS)
  })

  test('digest 是**裁剪后正文**的 sha256——否则同一条反馈会因裁剪前的噪音存成两行', () => {
    const withNoise = sanitizeReactionText({
      errorCode: 'e',
      errorDetail: 'boom\n    at a (/x.ts:1:1)',
      workspaceRoot: null,
    })
    const withoutNoise = sanitizeReactionText({
      errorCode: 'e',
      errorDetail: 'boom',
      workspaceRoot: null,
    })
    expect(withNoise.digest).toBe(withoutNoise.digest)
    expect(withNoise.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  test('ref 可往返解析，非法 ref 返回 null', () => {
    const { digest } = sanitizeReactionText({
      errorCode: 'e',
      errorDetail: 'd',
      workspaceRoot: null,
    })
    const ref = reactionArtifactRef('retry-feedback', digest)
    expect(parseReactionArtifactRef(ref)).toEqual({ kind: 'retry-feedback', digest })
    expect(parseReactionArtifactRef('nope')).toBeNull()
    expect(parseReactionArtifactRef('retry-feedback:zz')).toBeNull()
    expect(parseReactionArtifactRef(`unknown-kind:${digest}`)).toBeNull()
  })
})

describe('RFC-368 T1 —— 请求工厂', () => {
  const base = {
    employeeCase: { id: 'case-1', revision: 3 },
    roundRef: 'round-1',
    authority: { subject: 'user-1', revision: 7 },
    plan: { schemaVersion: 1, roundBudgetMs: 60_000 },
  }

  test('operation 由 (round, ordinal) 决定且稳定', () => {
    expect(reactionOperationRef('round-1', 0)).toBe(reactionOperationRef('round-1', 0))
    expect(reactionOperationRef('round-1', 0)).not.toBe(reactionOperationRef('round-1', 1))
    expect(() => reactionOperationRef('round-1', -1)).toThrow(/nonnegative/)
    expect(() => reactionOperationRef('', 0)).toThrow(/roundRef/)
  })

  test('initial 必须 ordinal 0 且不带反馈', () => {
    expect(() =>
      prepareReactionExecution({
        ...base,
        attempt: { ordinal: 1, mode: 'initial', retryFeedback: { kind: 'none' } },
      }),
    ).toThrow(/ordinal 0/)
    expect(() =>
      prepareReactionExecution({
        ...base,
        attempt: {
          ordinal: 0,
          mode: 'initial',
          retryFeedback: { kind: 'artifact', ref: 'retry-feedback:x' as never },
        },
      }),
    ).toThrow(/must not carry retry feedback/)
  })

  test('重试不能声称自己是第 0 次', () => {
    expect(() =>
      prepareReactionExecution({
        ...base,
        attempt: { ordinal: 0, mode: 'same-scene', retryFeedback: { kind: 'none' } },
      }),
    ).toThrow(/must not have ordinal 0/)
  })

  test('产物 deep-frozen，外部改不动', () => {
    const prepared = prepareReactionExecution({
      ...base,
      attempt: { ordinal: 0, mode: 'initial', retryFeedback: { kind: 'none' } },
    })
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared.request)).toBe(true)
    expect(Object.isFrozen(prepared.request.attempt)).toBe(true)
    expect(Object.isFrozen(prepared.request.plan)).toBe(true)
  })

  test('同输入同 hash；键的书写顺序不影响 hash', () => {
    const left = prepareReactionExecution({
      ...base,
      plan: { schemaVersion: 1, roundBudgetMs: 60_000 },
      attempt: { ordinal: 0, mode: 'initial', retryFeedback: { kind: 'none' } },
    })
    const right = prepareReactionExecution({
      ...base,
      plan: { roundBudgetMs: 60_000, schemaVersion: 1 },
      attempt: { ordinal: 0, mode: 'initial', retryFeedback: { kind: 'none' } },
    })
    expect(left.requestHash).toBe(right.requestHash)
    expect(left.requestHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('hash material 排除 brand 与 requestHash 自身', () => {
    const prepared = prepareReactionExecution({
      ...base,
      attempt: { ordinal: 0, mode: 'initial', retryFeedback: { kind: 'none' } },
    })
    // 只对 request 算，且与工厂给出的值相等 —— 说明 hash 没把自己或 brand 卷进去。
    expect(reactionRequestHash(prepared.request)).toBe(prepared.requestHash)
  })

  test('预算不同 ⇒ hash 不同（这正是 P1-4 要求把收敛后的 plan 写回 round 的原因）', () => {
    const attempt = {
      ordinal: 1,
      mode: 'same-scene' as const,
      retryFeedback: { kind: 'none' as const },
    }
    const full = prepareReactionExecution({ ...base, attempt, plan: { maxTotalTokens: 1000 } })
    const drained = prepareReactionExecution({ ...base, attempt, plan: { maxTotalTokens: 100 } })
    expect(full.requestHash).not.toBe(drained.requestHash)
  })
})
