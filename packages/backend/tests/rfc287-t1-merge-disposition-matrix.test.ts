// RFC-287 T1②③⑥ —— 五条装配线 × 三种合并结局的**处置矩阵**（拆分前 oracle）。
//
// 为什么存在：三轮设计门在同一处连续翻车三次——把「各线合并失败怎么收场」当成
// 一致的。逐锚实测下来只有 `throw → 保留 iso + 标记合并失败` 是五线共同默认，
// 其余两列各线都不同；而**现有测试一条都拦不住**这类翻转（`merge-back-conflict`
// 全仓只命中 rfc187 的两个工作组用例，s18/s19 套件里 conflict / awaiting_human /
// keep 一个字都没出现）。骨架若按「统一默认」实现，会静默改掉：
//   · fanout 分片/聚合：撞冲突今天是 discard + failed（fail-all-after-join），
//     统一成 keep + awaiting_human 就变成了「单片挂起等人」——产品语义变更；
//   · 脚本线：撞冲突今天靠谓词「碰巧」保住 iso，C2 改成功即删 + 骨架统一
//     `if (!keep) discard` 之后会连 resolve-iso 一起删掉，落成孤儿 conflict-human，
//     而恢复逻辑在每个任务入口都跑、会去找已回收的提交并 failTask 整个任务。
//
// 本文件把现状钉成可判定断言。RFC-287 落地后要改其中任何一格，必须在能力影响
// 清单里显式列出并配红→绿对（C8 已按此办：分片/聚合的 conflict-human 改 abandon）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SCHEDULER = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
  'utf8',
)

/** 去掉行注释与块注释，免得长注释把断言窗口顶出去。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 取 `marker` 之后那个 `{ … }` 分支体（大括号配平，绝不溢进相邻的 catch）。 */
function branchAfter(body: string, marker: string): string {
  const at = body.indexOf(marker)
  expect(at, `未找到分支标记：${marker}`).toBeGreaterThan(-1)
  const open = body.indexOf('{', at)
  expect(open).toBeGreaterThan(-1)
  let depth = 1
  let i = open + 1
  for (; i < body.length && depth > 0; i++) {
    if (body[i] === '{') depth++
    else if (body[i] === '}') depth--
  }
  return stripComments(body.slice(open + 1, i - 1))
}

function bodyOf(signature: string): string {
  const start = SCHEDULER.indexOf(signature)
  expect(start).toBeGreaterThan(-1)
  const rest = SCHEDULER.slice(start + signature.length)
  const next = rest.search(/\nasync function |\nfunction /)
  return next === -1 ? rest : rest.slice(0, next)
}

/** merge 抛出的共同默认：保留 iso + 标记合并失败。 */
// RFC-287 T3 改锚：聚合线已迁入骨架，其 throw 处置改由 spec 的 `onThrow` 声明式
// 表达（keep: true + markMergeFailed），故从本表移出、由下面的「已迁移线」用例接管。
// RFC-287 T4 改锚：分片线同聚合线一起迁入骨架，throw 处置改由 spec 的 onThrow
// 声明式表达，故从本表移出、由下面「已迁移线」的用例接管。
const LINES_WITH_DEFAULT_THROW = [
  ['agent-single', 'async function runOneNode(', 'keepIso = true'],
] as const

describe('RFC-287 T1 — 合并处置矩阵（现状）', () => {
  test('throw 列是唯一真默认：三线均 keep + markMergeFailed', () => {
    for (const [label, sig, keepVar] of LINES_WITH_DEFAULT_THROW) {
      const body = bodyOf(sig)
      const idx = body.indexOf('markMergeFailed')
      expect(idx, `${label}: 应有 markMergeFailed`).toBeGreaterThan(-1)
      // keep 标志与 markMergeFailed 同处 catch 块内（前后 400 字符窗口）。
      expect(
        body.slice(Math.max(0, idx - 400), idx),
        `${label}: 抛出时应先置 ${keepVar}`,
      ).toContain(keepVar)
    }
  })

  test('conflict-human 列逐线不同：分片/聚合是 failed 且**不**置 keep（fail-all）', () => {
    // 两条 fanout 线都已迁入骨架——撞冲突的处置改为 spec 上的 onConflictHuman
    // 声明；断言形态随之改变，语义（判失败且不保留 = fail-all）逐字保持。
    for (const sig of [
      'async function dispatchFanoutShardAttempt(',
      'async function dispatchFanoutAggregatorAttempt(',
    ]) {
      const branch = branchAfter(bodyOf(sig), 'onConflictHuman:')
      expect(branch).toMatch(/keep: false/)
      expect(branch).toMatch(/kind: 'failed' as const/)
      expect(branch).not.toMatch(/awaiting_human/)
    }
  })

  test('conflict-human 列：agent 线是 keep + awaiting_human', () => {
    const branch = branchAfter(
      bodyOf('async function runOneNode('),
      "merge.kind === 'conflict-human'",
    )
    expect(branch).toMatch(/keepIso = true/)
    expect(branch).toMatch(/kind: 'awaiting_human'/)
  })

  test('conflict-human 列：脚本线 awaiting_human，但 keep 是「谓词碰巧」而非显式声明', () => {
    const branch = branchAfter(
      bodyOf('async function runScriptNode('),
      "merge.kind === 'conflict-human'",
    )
    expect(branch).toMatch(/kind: 'awaiting_human'/)
    // 关键：该分支**没有**任何 keep 声明——iso 得以保住只是因为 finally 的谓词
    // `(!succeeded || isReadonly)` 恰好为假。C2 改成功路径即时 discard 后，这个
    // 「碰巧」就没了，必须改成显式声明（design §10.10）。
    expect(branch).not.toMatch(/keep/i)
  })

  test('工作组主机线：throw 是 keepHookIso + 重抛；conflict 是 abandon + failed', () => {
    const body = bodyOf('async function runHostNode(')
    expect(body).toMatch(/keepHookIso = true\s*\n\s*throw err/)
    const branch = branchAfter(body, "merge.kind === 'conflict-human'")
    expect(branch).toMatch(/kind: 'abandon'/)
    expect(branch).toMatch(/status: 'failed'/)
    expect(branch).not.toMatch(/awaiting_human/)
  })

  // ---------------------------------------------------------------------------
  // 已迁入骨架的线：处置不再是「函数体里的分支」，而是 spec 上的**声明**。
  // 断言形态随之从「分支体内含什么」改为「声明了什么」——语义等价，且更难写错。
  // ---------------------------------------------------------------------------
  test('两条 fanout 线（已迁骨架）：抛出 keep=true + markMergeFailed', () => {
    for (const sig of [
      'async function dispatchFanoutAggregatorAttempt(',
      'async function dispatchFanoutShardAttempt(',
    ]) {
      const b = bodyOf(sig)
      const th = branchAfter(b, 'onThrow:')
      expect(th, sig).toMatch(/keep: true/)
      expect(th, sig).toMatch(/markMergeFailed/)
    }
  })

  test('聚合线（已迁骨架）：撞冲突 keep=false 判失败、抛出 keep=true + markMergeFailed', () => {
    const body = bodyOf('async function dispatchFanoutAggregatorAttempt(')
    const conflict = branchAfter(body, 'onConflictHuman:')
    expect(conflict).toMatch(/keep: false/)
    expect(conflict).toMatch(/kind: 'failed' as const/)
    expect(conflict).not.toMatch(/awaiting_human/)

    const thrown = branchAfter(body, 'onThrow:')
    expect(thrown).toMatch(/keep: true/)
    expect(thrown).toMatch(/markMergeFailed/)
  })

  test('聚合线（已迁骨架）：processUnreaped ⇒ keep 的第五维仍在（§10.11）', () => {
    const body = bodyOf('async function dispatchFanoutAggregatorAttempt(')
    expect(body).toMatch(/keepFromOutcome: \(result\) => result\.processUnreaped === true/)
  })
})
