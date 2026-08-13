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
const ASSEMBLY_SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'schedulerAssembly.ts'),
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
// RFC-287 T7：agent 线是最后一条迁入骨架的。此前本表列的是「函数体里自己写
// keep 标志 + markMergeFailed」的线，迁完后这个集合归零——**默认处置本身**改由
// 骨架单点实现（keep=true + spec.markMergeFailed + settle）。下面那条断言随之
// 翻面：验的不再是「各线各写一份」，而是「谁都不许再自己写一份」。
const LINES_WITH_DEFAULT_THROW: ReadonlyArray<readonly [string, string, string]> = []

describe('RFC-287 T1 — 合并处置矩阵（现状）', () => {
  test('throw 列的默认处置已单点化：没有任何线再自己写 keep + markMergeFailed', () => {
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
    // 终局锁：默认处置只存在于骨架一处。agent 线现在把 markMergeFailed 声明成
    // spec 钩子（骨架在默认路径上调它），而不是自己在 catch 里 keep + 标记。
    expect(ASSEMBLY_SRC).toMatch(/keep = true\n\s*if \(spec\.markMergeFailed === undefined\)/)
    expect(ASSEMBLY_SRC).toContain('await spec.markMergeFailed(')
    // scheduler.ts 里不得再出现「先置 keep 标志、再 markMergeFailed」的手写默认。
    for (const m of SCHEDULER.matchAll(/markMergeFailed\(db,/g)) {
      const before = SCHEDULER.slice(Math.max(0, (m.index ?? 0) - 400), m.index ?? 0)
      expect(before, '默认 throw 处置必须单点在骨架，不得回流到调用线').not.toMatch(
        /keep\w* = true/,
      )
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

  test('conflict-human 列：agent 线（已迁骨架）是 keep + awaiting_human', () => {
    // T7 起处置是 spec 上的 onConflictHuman 声明；语义逐字保持：撞冲突保留 iso
    // （人要在那棵树上把冲突解完，resume 再合一次）并停在等待人工。
    const branch = branchAfter(bodyOf('async function runOneNode('), 'onConflictHuman:')
    expect(branch).toMatch(/keep: true/)
    expect(branch).toMatch(/kind: 'awaiting_human'/)
  })

  test('conflict-human 列：脚本线（已迁骨架）awaiting_human + 显式 keep', () => {
    // T5c 起该线的处置是 spec 上的 onConflictHuman 声明；语义与 T5a 落定的一致：
    // 撞冲突显式保留 iso（不再依赖 finally 谓词碰巧为假）并停在等待人工。
    const branch = branchAfter(bodyOf('async function runScriptNode('), 'onConflictHuman:')
    expect(branch).toMatch(/keep: true/)
    expect(branch).toMatch(/kind: 'awaiting_human' as const/)
  })

  test('工作组主机线（已迁骨架）：throw 是 keep + 重抛；conflict 是 abandon + failed', () => {
    // RFC-287 T6：处置改为 spec 上的声明，语义逐字保留——
    //   · onThrow：keep iso 并**重抛**（merge_state 留在 pending-merge 交 entry replay），
    //     刻意与 DAG 各线的 markMergeFailed 相反；
    //   · onConflictHuman：abandon 且 **不** keep（RFC-187 T8：留状态不留树会楔死任务）。
    const body = bodyOf('async function runHostNode(')
    const onThrow = branchAfter(body, 'onThrow:')
    expect(onThrow).toMatch(/keep: true/)
    expect(onThrow).toMatch(/then: 'rethrow'/)
    const branch = branchAfter(body, 'onConflictHuman:')
    expect(branch).toMatch(/kind: 'abandon'/)
    expect(branch).toMatch(/status: 'failed'/)
    expect(branch).not.toMatch(/awaiting_human/)
    // 本线的 conflict 分支必须**不**保留 iso——与脚本线/agent 线正好相反。
    expect(branch).toMatch(/keep: false/)
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
