// RFC-313 T2/T3 — 重试形状判定（decideRetryShape / retryAttemptCap）+ 会话升级告知
// （renderSessionRestartNotice / renderUserPrompt 的追加）的纯函数 oracle。
//
// 为什么这条测试存在：RFC-042 的同会话追问只按上一次 attempt 的形态二选一，重试
// 预算是一条直线烧下去的——于是「agent 每次正常退出、每次说话、每次不吐信封」这个
// 最典型的场景里，3 次重试全落在同一个越来越长的会话里，一次干净重启都不会发生，
// 而每次纠错提示还在加剧根因（上下文打满 / 模型陷在循环里）。RFC-313 补上「链触顶
// 即整体换一个干净会话」这一档。本文件锁死四件事：
//   ① 三态判定表逐格（含状态迁移）——design §2.2；
//   ② 「链触顶 + 升级预算已尽」的防御分支必须退回 followup、**绝不**白送一次
//      不计账的 fresh（换树换会话）；
//   ③ restartBudget=0 时永不产生 restart，且 attempt 上限退化成落地前的值
//      ——这是本特性的关闭开关，也是 AC-5 的纯函数级证明；
//   ④ 告知文案逐 reason 可区分、且不含上一次 attempt 的任何字节（机器读
//      errorMessage 是 RFC-145 明令禁止的，这里不开口子）。

import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  DEFAULT_SESSION_RESTART_BUDGET,
  decideRetryShape,
  renderSessionRestartNotice,
  renderUserPrompt,
  RETRY_ATTEMPT_CAP_CEILING,
  retryAttemptCap,
  type EnvelopeFollowupOutcome,
  type EnvelopeFollowupReason,
  type RetryShapeState,
} from '../src/prompt'

const REASONS: readonly EnvelopeFollowupReason[] = [
  'envelope-missing',
  'both-present',
  'clarify-malformed',
  'port-validation',
  'clarify-required',
  'envelope-port-malformed',
  'branch-marker',
]

const FRESH_START: RetryShapeState = { followupChainLen: 0, restartsUsed: 0 }
const followupable = (
  reason: EnvelopeFollowupReason = 'envelope-missing',
  failures: ReadonlyArray<{ port: string; kind: string; subReason: string }> = [],
): EnvelopeFollowupOutcome => ({ followup: true, reason, failures })
const notFollowupable: EnvelopeFollowupOutcome = { followup: false }

describe('RFC-313 decideRetryShape — 三态判定表', () => {
  test('链未触顶 → followup，链长 +1，升级预算不动', () => {
    const out = decideRetryShape({
      followup: followupable(),
      state: FRESH_START,
      followupBudget: 3,
      restartBudget: 1,
    })
    expect(out.shape.kind).toBe('followup')
    expect(out.next).toEqual({ followupChainLen: 1, restartsUsed: 0 })
  })

  test('链触顶且有升级预算 → restart，链归零、升级数 +1', () => {
    const out = decideRetryShape({
      followup: followupable('envelope-port-malformed'),
      state: { followupChainLen: 3, restartsUsed: 0 },
      followupBudget: 3,
      restartBudget: 1,
    })
    expect(out.shape).toEqual({ kind: 'restart', reason: 'envelope-port-malformed' })
    expect(out.next).toEqual({ followupChainLen: 0, restartsUsed: 1 })
  })

  test('RFC-042 判据落空 → fresh，链归零但升级预算**不**被消耗', () => {
    // 崩溃 / 超时 / 无 session / 无 text / 失败码不在 FOLLOWUP_POLICY 里。
    // 它不是主动放弃，是别无选择，不该吃掉那次聪明重启的机会（AC-6）。
    const out = decideRetryShape({
      followup: notFollowupable,
      state: { followupChainLen: 2, restartsUsed: 0 },
      followupBudget: 3,
      restartBudget: 1,
    })
    expect(out.shape).toEqual({ kind: 'fresh' })
    expect(out.next).toEqual({ followupChainLen: 0, restartsUsed: 0 })
  })

  test('防御分支：链触顶 + 升级预算已尽 → 退回 followup，绝不是 fresh', () => {
    // 该状态在 retryAttemptCap 的硬顶下不可达（见 decideRetryShape 的 doc）；
    // 这里直接构造它，锁住"宁可退回今天的行为，也不静默发放没有预算的升级"。
    const out = decideRetryShape({
      followup: followupable(),
      state: { followupChainLen: 3, restartsUsed: 1 },
      followupBudget: 3,
      restartBudget: 1,
    })
    expect(out.shape.kind).toBe('followup')
    expect(out.next.restartsUsed).toBe(1) // 没有偷偷再加一次
  })

  test('port-validation 的 failures 在 followup 形状下原样透传、restart 形状下不出现', () => {
    const failures = [{ port: 'audit', kind: 'json', subReason: 'not-json' }]
    const kept = decideRetryShape({
      followup: followupable('port-validation', failures),
      state: FRESH_START,
      followupBudget: 3,
      restartBudget: 1,
    })
    expect(kept.shape).toEqual({ kind: 'followup', reason: 'port-validation', failures })

    const escalated = decideRetryShape({
      followup: followupable('port-validation', failures),
      state: { followupChainLen: 3, restartsUsed: 0 },
      followupBudget: 3,
      restartBudget: 1,
    })
    expect(escalated.shape).toEqual({ kind: 'restart', reason: 'port-validation' })
    expect(JSON.stringify(escalated.shape)).not.toContain('not-json')
  })

  test('followupBudget=0 → 第一次可接续失败就直接升级（不先追问）', () => {
    const out = decideRetryShape({
      followup: followupable(),
      state: FRESH_START,
      followupBudget: 0,
      restartBudget: 1,
    })
    expect(out.shape.kind).toBe('restart')
  })

  test('待处理的 clarify 模式翻转压过升级：链触顶也不 restart（实现门 P1-1）', () => {
    // 为什么这条存在：升级会**丢隔离工作树 + 扣升级预算**，而一次 STOP 翻转按 RFC-122
    // 的处置应当「保树 + 走完整 prompt」。keepIf 跑在 spawn 之前，链顶恰逢翻转时若不
    // 压制，用户的一次正常翻转会被执行成升级——AC-8 违反，且未合并的磁盘成果被丢掉。
    const atCap = { followupChainLen: 3, restartsUsed: 0 }
    const escalates = decideRetryShape({
      followup: followupable(),
      state: atCap,
      followupBudget: 3,
      restartBudget: 1,
    })
    expect(escalates.shape.kind).toBe('restart') // 没有翻转时照常升级

    const suppressed = decideRetryShape({
      followup: followupable(),
      state: atCap,
      followupBudget: 3,
      restartBudget: 1,
      suppressRestart: true,
    })
    expect(suppressed.shape.kind).toBe('followup') // 翻转赢
    expect(suppressed.next.restartsUsed).toBe(0) // 预算一格未动
    expect(suppressed.next.followupChainLen).toBe(4) // 按 followup 记账 ⇒ 升级只是推迟一轮
  })

  test('suppressRestart 只压制 restart，不改变 followup / fresh 两态', () => {
    const belowCap = decideRetryShape({
      followup: followupable(),
      state: FRESH_START,
      followupBudget: 3,
      restartBudget: 1,
      suppressRestart: true,
    })
    expect(belowCap.shape.kind).toBe('followup')
    const crashed = decideRetryShape({
      followup: notFollowupable,
      state: { followupChainLen: 3, restartsUsed: 0 },
      followupBudget: 3,
      restartBudget: 1,
      suppressRestart: true,
    })
    expect(crashed.shape).toEqual({ kind: 'fresh' })
  })

  test('关闭开关：restartBudget=0 → 任何状态都产不出 restart', () => {
    for (const chain of [0, 1, 3, 10]) {
      const out = decideRetryShape({
        followup: followupable(),
        state: { followupChainLen: chain, restartsUsed: 0 },
        followupBudget: 3,
        restartBudget: 0,
      })
      expect(out.shape.kind).not.toBe('restart')
    }
  })

  test('荒谬预算被归一，不会把上限压到 1 以下', () => {
    expect(retryAttemptCap(-5, -5)).toBe(1)
    expect(retryAttemptCap(Number.NaN, 2)).toBe(3)
    expect(retryAttemptCap(2.9, 0)).toBe(3)
  })
})

describe('RFC-313 retryAttemptCap — attempt 硬上限', () => {
  test('默认配置 = 8；关闭开关时退化为落地前的 4', () => {
    expect(retryAttemptCap(DEFAULT_PROTOCOL_RETRY_BUDGET, DEFAULT_SESSION_RESTART_BUDGET)).toBe(8)
    expect(retryAttemptCap(DEFAULT_PROTOCOL_RETRY_BUDGET, 0)).toBe(
      1 + DEFAULT_PROTOCOL_RETRY_BUDGET,
    )
  })

  test('设置项边界的乘积被钳到天花板，不会撞上装配骨架的 spec-bug 保险丝', () => {
    // 两个旋钮相乘：50 × 10 单看都不离谱，乘起来是 561 次 attempt。保险丝的报错
    // 写的是「spec bug」，用它接住一个配置选择只会把运维引到错误方向。
    expect(retryAttemptCap(50, 10)).toBe(RETRY_ATTEMPT_CAP_CEILING)
    expect((1 + 50) * (1 + 10)).toBeGreaterThan(RETRY_ATTEMPT_CAP_CEILING)
    // 现实预算离天花板很远，钳制只可能在荒谬配置上生效。
    expect(
      retryAttemptCap(DEFAULT_PROTOCOL_RETRY_BUDGET, DEFAULT_SESSION_RESTART_BUDGET),
    ).toBeLessThan(RETRY_ATTEMPT_CAP_CEILING)
  })

  test('天花板 = 保险丝−1：此前能正常工作的配置在 R=0 下逐字不变（实现门 P2-3）', () => {
    // 原先取 64 会把 `F=64,R=0`（裸改 config.json 可达，设置页上限 50 达不到）从 65 次
    // 悄悄截成 64 次——一个没人要的行为变更，也让「R=0 等价于落地前」出现例外。
    // 取「保险丝−1」后：凡是在 RFC-313 之前能跑完的配置，其 attempt 数必然 ≤ 99
    // （否则当时就已经撞保险丝了），因此钳制对它们全部是恒等的。
    expect(RETRY_ATTEMPT_CAP_CEILING).toBe(99)
    for (const F of [0, 3, 50, 63, 64, 98]) {
      expect(retryAttemptCap(F, 0)).toBe(1 + F) // 逐字等于落地前的 1+retries
    }
  })

  test('全组合模拟：永远失败时的 attempt 总数恰为 (1+F)×(1+R)', () => {
    for (let F = 0; F <= 5; F += 1) {
      for (let R = 0; R <= 3; R += 1) {
        const cap = retryAttemptCap(F, R)
        let state: RetryShapeState = { ...FRESH_START }
        let attempts = 1 // 首发
        let restarts = 0
        // 调度器的 shouldRetry 只认硬顶：k 从 0 起，k < cap - 1 时才允许再来一次。
        for (let k = 0; k < cap - 1; k += 1) {
          const out = decideRetryShape({
            followup: followupable(),
            state,
            followupBudget: F,
            restartBudget: R,
          })
          if (out.shape.kind === 'restart') restarts += 1
          state = out.next
          attempts += 1
        }
        expect(attempts).toBe(cap)
        // 纯信封失败场景下升级预算应被恰好用满（F=0 时每次重试都是升级，
        // 上限本身就只允许 R 次重试）。
        expect(restarts).toBe(R)
      }
    }
  })
})

describe('RFC-313 renderSessionRestartNotice', () => {
  test('每个 reason 都有非空且互不相同的文案', () => {
    const seen = new Map<string, EnvelopeFollowupReason>()
    for (const reason of REASONS) {
      const text = renderSessionRestartNotice(reason)
      expect(text.length).toBeGreaterThan(0)
      const prior = seen.get(text)
      expect(prior).toBeUndefined()
      seen.set(text, reason)
    }
    expect(seen.size).toBe(REASONS.length)
  })

  test('文案指向"上方指定的格式"而非"本会话之前指定的格式"', () => {
    // 新会话没有任何历史；沿用 renderEnvelopeFollowupPrompt 的措辞会让模型去找
    // 一段它从未见过的对话。
    for (const reason of REASONS) {
      const text = renderSessionRestartNotice(reason)
      expect(text).toContain('specified above')
      expect(text).not.toContain('previously specified in this session')
    }
  })

  test('零用户可控插值：入参只有枚举，文案里不含模板占位或引号包裹的外来值', () => {
    for (const reason of REASONS) {
      const text = renderSessionRestartNotice(reason)
      expect(text).not.toContain('${')
      expect(text).not.toContain('errorMessage')
    }
  })
})

describe('RFC-313 renderUserPrompt — 告知的追加', () => {
  const base = {
    promptTemplate: 'do the thing',
    inputs: {},
    agentOutputs: ['summary'],
  }

  test('缺省时输出逐字节等于引入本字段前', () => {
    // 黄金锁：绝大多数 attempt 走这条路，一个字节都不许变。
    const withoutField = renderUserPrompt({ ...base })
    const withUndefined = renderUserPrompt({ ...base, priorSessionAbandoned: undefined })
    expect(withUndefined).toBe(withoutField)
    expect(withoutField).not.toContain('Note on an earlier attempt')
  })

  test('给出时追加在协议块之后（最靠近回复位置）', () => {
    const rendered = renderUserPrompt({
      ...base,
      priorSessionAbandoned: { reason: 'envelope-missing' },
    })
    const plain = renderUserPrompt({ ...base })
    expect(rendered.startsWith(plain)).toBe(true)
    expect(rendered.slice(plain.length)).toBe(renderSessionRestartNotice('envelope-missing'))
    expect(rendered.indexOf('Note on an earlier attempt')).toBeGreaterThan(
      rendered.indexOf('workflow-output'),
    )
  })
})
