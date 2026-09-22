// RFC-368 T3 —— Reaction 的**两套**重试判据，抽成纯函数。
//
// 它们是两套，不是一套的两种写法：计数器不同、公式不同、终结分支不同。设计门 r1 的 P1-7 正是
// 因为初稿只认识其中一套，把另一套整条丢了（后果：launch 永久失败的 round 会无限重试、
// 案例永不终结）。这里把两套都钉成可断言的纯函数，各自与改造前逐值对拍（AC-8）。
//
//   ① round 级 —— 执行**跑完了但失败**之后要不要再跑一轮。
//      今天在 `application/runtimeService.ts` 的 `#retryOrFailExecution`，计数器是 round 的
//      `attemptOrdinal`，退避取 `2 ** (nextOrdinal - 1)`。
//
//   ② 派发级 —— `launch` 这个动作**本身**失败（例如引用的 agent 已删）之后要不要再派一次。
//      今天在 `runOneOutbox` 的 catch 里，计数器是 outbox 行的 `attemptCount`，
//      退避取 `2 ** (attemptCount - 1)`。退役 `execution-launch` 之后这套要搬到 round 的
//      `dispatch_attempts` 上，公式与终结判据逐字不变。
//
// 两套共用 `retryAttemptCap`，但用法不同：① 拿 `cap - 1` 当 ordinal 的上界（ordinal 从 0 起），
// ② 拿 `max(1, cap)` 当 attemptCount 的上界（attemptCount 从 1 起）。这个差一位是历史事实，
// 不是笔误——改任何一个都会让重试总次数变化。

import { retryAttemptCap } from '@/platform/contracts/retryAttemptCap'

/** 两套判据都只认这四个旋钮，与 `employee_execution_policy_revisions` 的内容同形。 */
export interface ReactionRetryPolicyV1 {
  readonly sameSceneAttempts: number
  readonly freshSceneAttempts: number
  readonly initialBackoffMs: number
  readonly maxBackoffMs: number
}

export type ReactionAttemptMode = 'initial' | 'same-scene' | 'fresh-scene'

export interface RoundRetryDecisionV1 {
  /** 还要不要再跑一轮。false ⇒ 调用方去结算 round。 */
  readonly retry: boolean
  /** `retry === true` 时才有意义。 */
  readonly nextOrdinal: number
  readonly mode: ReactionAttemptMode
  readonly delayMs: number
}

/**
 * ① round 级判据。逐字对应 `#retryOrFailExecution` 里的四段算术：
 *
 *   attemptsPerScene = sameSceneAttempts + 1
 *   nextOrdinal      = boundaryFailure
 *                        ? max(ordinal+1, (floor(ordinal / attemptsPerScene) + 1) * attemptsPerScene)
 *                        : ordinal + 1
 *   retryBudget      = retryAttemptCap(sameScene, freshScene) - 1
 *   mode             = nextOrdinal % attemptsPerScene === 0 ? 'fresh-scene' : 'same-scene'
 *   delay            = min(maxBackoffMs, initialBackoffMs * 2 ** max(0, nextOrdinal - 1))
 *
 * `boundaryFailure` 的含义是「工作区边界类失败」——它不在同一个场景里重试，直接跳到下一个
 * 场景边界（`boundaryEscalates` 判定，调用方传入）。
 */
export function roundRetrySchedule(input: {
  readonly attemptOrdinal: number
  readonly boundaryFailure: boolean
  readonly policy: ReactionRetryPolicyV1
}): RoundRetryDecisionV1 {
  const attemptsPerScene = input.policy.sameSceneAttempts + 1
  const nextOrdinal = input.boundaryFailure
    ? Math.max(
        input.attemptOrdinal + 1,
        (Math.floor(input.attemptOrdinal / attemptsPerScene) + 1) * attemptsPerScene,
      )
    : input.attemptOrdinal + 1
  const retryBudget =
    retryAttemptCap(input.policy.sameSceneAttempts, input.policy.freshSceneAttempts) - 1
  if (nextOrdinal > retryBudget) {
    return { retry: false, nextOrdinal, mode: 'same-scene', delayMs: 0 }
  }
  return {
    retry: true,
    nextOrdinal,
    mode: nextOrdinal % attemptsPerScene === 0 ? 'fresh-scene' : 'same-scene',
    delayMs: Math.min(
      input.policy.maxBackoffMs,
      input.policy.initialBackoffMs * 2 ** Math.max(0, nextOrdinal - 1),
    ),
  }
}

export interface DispatchRetryDecisionV1 {
  /** true ⇒ 派发预算耗尽，调用方走终结三分支（settle / terminate / block）。 */
  readonly terminal: boolean
  readonly delayMs: number
}

/**
 * ② 派发级判据。逐字对应 `runOneOutbox` catch 里的那四行：
 *
 *   maxAttempts = retryAttemptCap(sameScene ?? 1, freshScene ?? 1)
 *   terminal    = limitReached || attemptCount >= max(1, maxAttempts)
 *   backoff     = min(maxBackoffMs ?? 60_000, (initialBackoffMs ?? 1_000) * 2 ** max(0, attemptCount - 1))
 *
 * `policy` 允许为 null：今天案例查不到时用 `getCurrentExecutionPolicy()`，再查不到就落到
 * 这几个字面缺省值（1 / 1 / 1_000 / 60_000）。这些缺省不是随便写的，是 outbox 那段的原值。
 */
export function dispatchRetrySchedule(input: {
  readonly dispatchAttempts: number
  readonly limitReached: boolean
  readonly policy: ReactionRetryPolicyV1 | null
}): DispatchRetryDecisionV1 {
  const maxAttempts = retryAttemptCap(
    input.policy?.sameSceneAttempts ?? 1,
    input.policy?.freshSceneAttempts ?? 1,
  )
  const initial = input.policy?.initialBackoffMs ?? 1_000
  const maximum = input.policy?.maxBackoffMs ?? 60_000
  return {
    terminal: input.limitReached || input.dispatchAttempts >= Math.max(1, maxAttempts),
    delayMs: Math.min(maximum, initial * 2 ** Math.max(0, input.dispatchAttempts - 1)),
  }
}

/**
 * 在途迁移用（RFC-368 design §5）：`execution-launch` 行的 `payload.attempt.mode` 不入库，
 * 迁移后由 ordinal 重算。公式与 `roundRetrySchedule` 里那一行同源。
 */
export function attemptModeForOrdinal(
  ordinal: number,
  sameSceneAttempts: number,
): ReactionAttemptMode {
  if (ordinal === 0) return 'initial'
  return ordinal % (sameSceneAttempts + 1) === 0 ? 'fresh-scene' : 'same-scene'
}
