// RFC-317 T49 · findings LC-03 —— `allowTerminal` 逃生口的逐文件精确账本。
//
// 「终态就是终态」是两台状态机共同承重的不变量——正因为它成立，
// `isTerminalNodeRunStatus` 才能在下游任何地方当作「已结算」的闸使用。
// 而 `allowTerminal: true` 是一个**任何调用方都能自己打开**的布尔逃生口：
//
//   · `services/lifecycle.ts` 对 `setNodeRunStatus.allowTerminal` 写着
//     「Default false. Set true ONLY for fixup scripts — never in normal flows.」
//   · 对 `setTaskStatus` 写着「holders: resumeTask, retryNode, repair CR-1,
//     repair T3, and RFC-109 syncTaskWorkflow」——**五个具名持有者**。
//
// 开账时实测是 **21 个生产站点**；RFC-339 把 scheduler 中 5 个 wrapper 站点收敛到
// wrapperMechanics / wrapperRunLifecycle 的 3 个具名站点，当前为 **19 个**。其中仍包含正常
// 用户流程：review supersede 把一条 `done` 的 node_run 改写成 `canceled`（review.ts）、
// review 兄弟级联把 `done` 改回 `pending`。
// 共享表在这件事上是**斩钉截铁**的：`nextNodeRunStatus` 对任何终态 `cur` 直接抛，
// `nextTaskStatus` 唯二能从终态出发的事件是 `retry` / `sync-workflow`（都只到 `pending`）。
//
// 文档说五个、实际远多于五个，后果不是「文档过期」这么轻——**审下一条新增站点的人失去了
// 基线**：他看不出自己是在扩大既有口子，还是在做一件早有先例的常规操作。
//
// 本文件不改任何语义（那是另一次独立决策），只把现状变成**可见且只能减**的账本：
// 逐文件精确计数 + 每条写清它改写的是哪种终态→X。新增一个站点 ⇒ 红；
// 修掉一个而不销账 ⇒ 也红（否则差额会变成下一个人的免费槽位）。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { packageSrcUnits, sourceUnit, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

interface AllowTerminalLedgerEntry {
  readonly file: string
  readonly count: number
  /** 这些站点各自把什么终态改写成什么。 */
  readonly rewrites: string
}

/**
 * 开账当天（RFC-317 T49）为 21 个生产站点；RFC-339 收敛后当前为 19 个。
 *
 * 计数走 AST（`allowTerminal: true` 的属性赋值），不是文本——`lifecycle.ts` 的头注释里
 * 就写着这个词组两次，文本计数会把说明自己的那两行算成站点。
 */
const ALLOW_TERMINAL_LEDGER: readonly AllowTerminalLedgerEntry[] = [
  {
    file: 'packages/backend/src/modules/task-execution/composition/wrapperMechanics.ts',
    count: 2,
    rewrites:
      '2 处 *→pending 的 fanout shard/aggregator 同代残留重跑（allowedFrom 含 interrupted/failed/canceled）。',
  },
  {
    file: 'packages/backend/src/modules/task-execution/composition/wrapperRunLifecycle.ts',
    count: 1,
    rewrites:
      'pending|awaiting_review|awaiting_human|interrupted|canceled→running 的 wrapper generation 重新认领；同一站点覆盖 git/loop/fanout 三种 wrapper。',
  },
  {
    file: 'packages/backend/src/modules/task-execution/composition/nodeMechanics.ts',
    count: 2,
    rewrites:
      'done→failed（workgroup host 的 ask-back 被晚到策略关闭）与 pending|interrupted|canceled→running（call child adoption 复用既有行）。',
  },
  {
    file: 'packages/backend/src/modules/collaboration/infrastructure/legacySqliteReview.ts',
    count: 2,
    rewrites:
      'done→canceled（评审被 supersede，旧轮次作废）、done→pending（兄弟级联重开）。**这两处是正常用户流程**，与 lifecycle.ts 头注释「never in normal flows」直接冲突——账本先如实记下，语义处置另立决策。',
  },
  {
    file: 'packages/backend/src/services/task.ts',
    count: 3,
    rewrites:
      'resumeTask / retryNode / syncTaskWorkflow 三条——正是头注释点名的持有者中的三个，终态→pending。',
  },
  {
    file: 'packages/backend/src/platform/persistence/sqlite/taskLifecycleRepair/options-R1.ts',
    count: 1,
    rewrites: 'R1 修复：把卡住的 node_run 收成终态。',
  },
  {
    file: 'packages/backend/src/platform/persistence/sqlite/taskLifecycleRepair/options-R2.ts',
    count: 1,
    rewrites: 'R2 修复：done→awaiting_review（评审行丢失，把任务退回评审）。',
  },
  {
    file: 'packages/backend/src/platform/persistence/sqlite/taskLifecycleRepair/options-T1.ts',
    count: 1,
    rewrites: 'T1 修复：failed|canceled|interrupted|exhausted→awaiting_review。',
  },
  {
    file: 'packages/backend/src/platform/persistence/sqlite/taskLifecycleRepair/options-T2.ts',
    count: 1,
    rewrites: 'T2 修复：failed|canceled|interrupted|exhausted→awaiting_human。',
  },
  {
    file: 'packages/backend/src/platform/persistence/sqlite/taskLifecycleRepair/options-T3.ts',
    count: 2,
    rewrites: 'T3 修复：done→interrupted 与 done→failed（把误判为完成的任务打回）。',
  },
  {
    file: 'packages/backend/src/platform/persistence/sqlite/taskLifecycleRepair/options-S3.ts',
    count: 2,
    rewrites: 'S3 修复：两处 failed|canceled|interrupted|exhausted→pending 的重跑。',
  },
  {
    file: 'packages/backend/src/platform/persistence/sqlite/taskLifecycleRepair/options-CR1.ts',
    count: 1,
    rewrites: 'CR-1 修复：failed→interrupted（把误判失败的任务恢复成可续跑）。',
  },
]

/** 一个文件里 `allowTerminal: true` 的**属性赋值**个数（AST，注释与字符串免疫）。 */
export function allowTerminalSiteCount(unit: SourceUnit): number {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'allowTerminal' &&
      node.initializer.kind === ts.SyntaxKind.TrueKeyword
    ) {
      count += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return count
}

describe('RFC-317 T49 —— allowTerminal 站点账本（只减不增）', () => {
  const units = packageSrcUnits(REPO_ROOT, 'backend')

  test('语料非空（扫空即假绿）', () => {
    expect(units.length).toBeGreaterThan(700)
  })

  test('逐文件计数与账本**逐条相等**', () => {
    const actual = units
      .map((unit) => ({ file: unit.path, count: allowTerminalSiteCount(unit) }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => a.file.localeCompare(b.file))
    const expected = [...ALLOW_TERMINAL_LEDGER]
      .map((entry) => ({ file: entry.file, count: entry.count }))
      .sort((a, b) => a.file.localeCompare(b.file))
    expect(
      actual,
      '新增了 allowTerminal 站点（去 review 里说清为什么这条终态改写值得），或者修掉了一个却没把账本一起改小——后者会把差额变成下一个人的免费槽位',
    ).toEqual(expected)
  })

  test('总数就是 19，且每条都写清了改写什么', () => {
    // 总数单独锁一条：逐文件相等已经能抓住增减，但「19」仍是 lifecycle.ts
    // 头注释里那句「五个具名持有者」的反证，值得让它在测试里显式出现一次。
    expect(ALLOW_TERMINAL_LEDGER.reduce((sum, entry) => sum + entry.count, 0)).toBe(19)
    for (const entry of ALLOW_TERMINAL_LEDGER) {
      expect(entry.rewrites.length, `${entry.file}.rewrites`).toBeGreaterThan(15)
    }
  })

  test('内核头注释不再声称存在一条 ESLint 规则（LC-07）', () => {
    // `no-direct-node-run-status-write` 在全仓只有一处命中：那句声称它存在的注释本身。
    // 审内核是否密封的人第一眼读到的就是它，会据此认定存在 lint 级、不可绕过的守卫。
    const lifecycle = units.find(
      (unit) => unit.path === 'packages/backend/src/platform/persistence/sqlite/taskLifecycle.ts',
    )
    expect(lifecycle).toBeDefined()
    expect(
      lifecycle!.text.includes('no-direct-node-run-status-write'),
      '内核头注释又提到了一条不存在的 ESLint 规则——要么实现它，要么指向真正的守卫文件',
    ).toBe(false)
    // 且全仓其它地方也不得出现（实现了它再来改这条）。
    const elsewhere = units.filter((unit) => unit.text.includes('no-direct-node-run-status-write'))
    expect(elsewhere.map((unit) => unit.path)).toEqual([])
  })
})

describe('RFC-317 T49 负向 fixture —— 计数判据真的会咬', () => {
  test('属性赋值被计入', () => {
    expect(
      allowTerminalSiteCount(
        sourceUnit('packages/backend/src/x.ts', `const a = { to: 'pending', allowTerminal: true }`),
      ),
    ).toBe(1)
  })

  test('**注释里**提到不计入（文本计数会把说明自己的那行算成站点）', () => {
    expect(
      allowTerminalSiteCount(
        sourceUnit(
          'packages/backend/src/x.ts',
          `// 需要改写终态的站点传 allowTerminal: true\nexport const ok = 1`,
        ),
      ),
    ).toBe(0)
  })

  test('`allowTerminal: false` 不计入（关着的口子不是口子）', () => {
    expect(
      allowTerminalSiteCount(
        sourceUnit('packages/backend/src/x.ts', `const a = { allowTerminal: false }`),
      ),
    ).toBe(0)
  })

  test('变量转发不计入（判据只认字面 true —— 这是已知盲区，见下）', () => {
    // `allowTerminal: someFlag` 逃得过这条计数。承认它而不是假装没有：真要堵死，
    // 得把布尔换成不可伪造的能力令牌（finding 的 stronger form），那是一次独立的
    // 语义改动，不该混进一次「把现状变可见」的记账里。
    expect(
      allowTerminalSiteCount(
        sourceUnit('packages/backend/src/x.ts', `const a = { allowTerminal: flag }`),
      ),
    ).toBe(0)
  })
})
