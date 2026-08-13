// RFC-287 T5 / C1 —— 漂移 A 的红→绿对：脚本节点合并抛出不再楔死整个作用域。
//
// 现状（红）：脚本线的 `mergeBackAndSettle` 是**裸调用、无 try/catch**——而其余四条
// 装配线都有。合并一旦抛出（git 层出错、仓库状态异常、超时），异常会穿过 finally
// 一路掀翻调度循环：
//   · 任务以一个笼统的内部错误收场，而**不是**「某个节点失败」；
//   · 该脚本节点的运行行停在非终态，界面上看不到「合并失败」；
//   · 同一时刻在跑的兄弟节点被丢下不管；
//   · 用户没有「重试这个节点」的落点，只能整个任务重来。
// 而同样的事发生在 agent / fanout 分片 / 聚合线上：保留隔离工作树 + 标记合并失败
// + 节点判失败，任务正常收敛，可以只重试那一个节点。
//
// 目标（绿）：脚本线收敛到同一处置。这是本 RFC **唯一**的行为变更（能力影响清单
// C1），故必须有红→绿对，不能靠「统一默认」偷渡。
//
// 断言形态说明：完整跑一次「合并抛出」的调度集成太重（要造 git 层故障），故锁
// **处置声明**——迁入骨架后这条线的处置就是 spec 上的 `disposition.onThrow`，
// 与 rfc287-t1-merge-disposition-matrix 对另外几条线的锁同形。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SCHEDULER = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
  'utf8',
)

function bodyOf(signature: string): string {
  const start = SCHEDULER.indexOf(signature)
  expect(start, `未找到函数：${signature}`).toBeGreaterThan(-1)
  const rest = SCHEDULER.slice(start + signature.length)
  const next = rest.search(/\nasync function |\nfunction /)
  return next === -1 ? rest : rest.slice(0, next)
}

function branchAfter(body: string, marker: string): string {
  const at = body.indexOf(marker)
  expect(at, `未找到：${marker}`).toBeGreaterThan(-1)
  const open = body.indexOf('{', at)
  let depth = 1
  let i = open + 1
  for (; i < body.length && depth > 0; i++) {
    if (body[i] === '{') depth++
    else if (body[i] === '}') depth--
  }
  return body.slice(open + 1, i - 1)
}

describe('RFC-287 T5 / C1 — 脚本节点合并抛出的处置（漂移 A）', () => {
  // 断言写成**不预设实现形态**：现在是 try/catch 里置 keep + markMergeFailed，
  // 迁入骨架后会变成 spec 上的 `disposition.onThrow` 声明——两种形态都该通过。
  // 锁的是「这条线对合并抛出有显式处置，且处置是保留 iso + 标记合并失败」。
  const script = bodyOf('async function runScriptNode(')

  test('合并抛出有显式处置（不再穿透掀翻整个调度循环）', () => {
    const mergeAt = script.indexOf('mergeBackAndSettle(')
    expect(mergeAt, '脚本线应有 merge-back').toBeGreaterThan(-1)
    // 现状红：mergeBackAndSettle 是裸调用，其后 600 字符内既无 catch 也无 onThrow。
    const around = script.slice(Math.max(0, mergeAt - 400), mergeAt + 900)
    expect(around).toMatch(/catch \(err\)|onThrow:/)
  })

  test('处置内容 = 保留 iso + 标记合并失败 + 判该节点失败', () => {
    const mergeAt = script.indexOf('mergeBackAndSettle(')
    const around = script.slice(mergeAt, mergeAt + 2000)
    expect(around).toMatch(/markMergeFailed/)
    // 形态无关：现状是具名标志 `keepScriptIso = true`，迁入骨架后会变成
    // spec 声明里的 `keep: true`——两种都算。
    expect(around).toMatch(/keep\w*Iso = true|keep: true/)
    expect(around).toMatch(/kind: 'failed'/)
  })

  test('与其余已迁线同处置（收敛目标）', () => {
    for (const sig of [
      'async function dispatchFanoutShardAttempt(',
      'async function dispatchFanoutAggregatorAttempt(',
    ]) {
      const thrown = branchAfter(bodyOf(sig), 'onThrow:')
      expect(thrown, sig).toMatch(/keep: true/)
      expect(thrown, sig).toMatch(/markMergeFailed/)
    }
  })
})
