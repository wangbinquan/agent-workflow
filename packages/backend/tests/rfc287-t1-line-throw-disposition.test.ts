// RFC-287 T1⑨ —— 五条装配线的「抛出结局」与 keep 分歧的**行为夹具**（拆分前 oracle）。
//
// 为什么存在：三轮设计门连续在同一处翻车——把「各线遇到异常怎么收场」当成了一致的，
// 实测每条线都不同，而现有测试**一条都拦不住**这类翻转。骨架抽取会把这些分支重写，
// 所以必须先把现状钉成可判定的断言，再动刀（design §10.2 的 onUnhandledThrow /
// §10.10 的 persistIsoBase 相位定案，都以本文件的实测为判据）。
//
// 锁三件事：
//   ① 线级 catch-all 的**载荷**逐线不同——尤其 fanout 分片/聚合的 catch-all 带
//      `retry` 且 failureCode 为 null，而 `shouldRetryNodeFailure(null)` 为 true，
//      即「分片体内抛异常」今天**会被重试到上限**。骨架若把「未兜住的抛出」统一
//      成「装配失败」，这条重试语义会被静默取消。
//   ② `shouldRetryNodeFailure` 对 null 的判定是上面那条的支点，单独钉死。
//   ③ keep 的分歧：clarify-park 在 agent 线是 keep（同会话续跑要原工作树），在
//      工作组主机线是不 keep（直接 return、finally 无条件清理）。
//
// 这些是**现状**断言。RFC-287 落地后若要改变其中任何一条，必须在能力影响清单里
// 显式列出并配红→绿对，不能靠「统一默认」偷渡。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shouldRetryNodeFailure } from '../src/services/scheduler'

const SCHEDULER = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
  'utf8',
)

/** 取某个函数体（自签名起到下一个顶层 `async function` 前）。 */
function bodyOf(signature: string): string {
  const start = SCHEDULER.indexOf(signature)
  expect(start, `未找到函数：${signature}`).toBeGreaterThan(-1)
  // ⚠️ 括号配平，**不能**靠「下一个 function 声明」当边界（四轮门测试有效性自查
  // 实测）：`runHostNode` 是嵌套在 `buildWorkgroupHooks` 里的函数，它的兄弟钩子都写成
  // `const x = async () =>`，正则边界一个都不命中，于是切片一路跑出真实函数体
  // 159 行——把兄弟钩子与两个导出函数全吞了进来。实测把边界补上 `export ` 前缀只收窄
  // 了 31 行，仍然吞着别人的代码。只有配平括号才切得准。
  const open = SCHEDULER.indexOf('{', start + signature.length - 1)
  let depth = 1
  let i = open + 1
  for (; i < SCHEDULER.length && depth > 0; i++) {
    if (SCHEDULER[i] === '{') depth++
    else if (SCHEDULER[i] === '}') depth--
  }
  return SCHEDULER.slice(open + 1, i - 1)
}

describe('RFC-287 T1⑨ — 抛出结局与 keep 分歧（拆分前现状）', () => {
  test('② shouldRetryNodeFailure(null) === true —— 这是分片抛出即重试的支点', () => {
    expect(shouldRetryNodeFailure(null)).toBe(true)
  })

  test('未回收的旧 child 禁止 fresh-process 重试，已回收的 identity-invalid 仍可重试', () => {
    expect(shouldRetryNodeFailure('runtime-session-identity-invalid')).toBe(true)
    expect(shouldRetryNodeFailure('runtime-session-identity-invalid', true)).toBe(false)
    expect(shouldRetryNodeFailure(null, true)).toBe(false)
  })

  test('① fanout 分片（已迁骨架）：兜底改由 onUnhandledThrow 声明，载荷不变', () => {
    const body = bodyOf('async function dispatchFanoutShardAttempt(')
    // catch-all 里同时出现「广播 failed」与「retry 载荷」，且 failureCode 显式为 null。
    expect(body).toMatch(
      /onUnhandledThrow: \(err\)[\s\S]{0,400}retry: \{ retryIndex: shardRetryIndex, failureCode: null \}/,
    )
    expect(body).toMatch(
      /onUnhandledThrow: \(err\)[\s\S]{0,400}broadcastNodeStatus\(taskId, shardRunId/,
    )
  })

  test('① 聚合节点（已迁骨架）：线级兜底改由 onUnhandledThrow 声明，载荷不变', () => {
    // RFC-287 T3 改锚：该线的 catch-all 已迁入骨架，形态从「函数体里的 catch 块」
    // 变成「spec 上的 onUnhandledThrow 声明」——**载荷必须逐字不变**，尤其
    // failureCode 为 null 这一条（它决定了抛出会被重试到上限）。
    const body = bodyOf('async function dispatchFanoutAggregatorAttempt(')
    expect(body).toMatch(
      /onUnhandledThrow: \(err\)[\s\S]{0,400}retry: \{ retryIndex: aggRetryIndex, failureCode: null \}/,
    )
  })

  test('① agent 线与 script 线的抛出**不**变成可重试失败（与 L5/L6 相对）', () => {
    // 两条线是 try/finally 无线级 catch，抛出直穿到 scope 循环；L5/L6 则把抛出
    // 收成带 retry 载荷的 failed。锁住这个差异本身——骨架若给它们加同款 catch，
    // 「抛出直穿」会变成「抛出即重试」，是静默的语义变更。
    for (const sig of ['async function runOneNode(', 'async function runScriptNode(']) {
      expect(bodyOf(sig)).not.toMatch(/catch \([\s\S]{0,600}failureCode: null/)
    }
  })

  test('③ keep 分歧：agent 线的 clarify-park 置 keepIso，工作组主机线不置', () => {
    // RFC-287 T7：agent 线迁入骨架后，clarify 停靠是 mergePhase 上的 park 声明
    // （跳合并 + keep），语义与迁移前的 `keepIso = true` 逐字一致。
    const agent = bodyOf('async function runOneNode(')
    expect(agent).toMatch(
      /clarify !== undefined\) \{\s*\n\s*return \{ skip: 'park', keep: true, then: 'settle' \}/,
    )
    // 工作组主机线的 clarify 分支直接 return，不置 keep（finally 无条件清理）。
    const host = bodyOf('async function runHostNode(')
    const clarifyIdx = host.indexOf('clarify')
    expect(clarifyIdx).toBeGreaterThan(-1)
    expect(host.slice(clarifyIdx, clarifyIdx + 600)).not.toMatch(/keepHookIso = true/)
  })
})
