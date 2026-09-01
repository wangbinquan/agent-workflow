// RFC-317 T47 · findings LC-01 —— CAS 写入必须服从它自己的转移表。
//
// 两台状态机各有一张「(状态, 事件) → 状态」的表，注释里自称单一事实源。实测：
// **写入者从不查它**。
//
//   · `setTaskStatus` 读行、判 `isTerminalTaskStatus(from) && !allowTerminal`、再判
//     `args.allowedFrom.includes(from)` —— 全程不 import、不调用 `nextTaskStatus`。
//     唯一从表里派生 allowedFrom 的是薄封装 `transitionTaskStatusByEvent`，
//     而它在 lifecycle.ts 之外**只有一个**生产调用者。
//   · node 侧同形：`setNodeRunStatus` 从不调 `nextNodeRunStatus`，且它有 49 个生产
//     调用点，事件路径只有 25 个；`mark-done` / `mark-failed` / `mark-canceled` /
//     `iterate-review` / `reject-review` / `mark-exhausted` 六个事件**零生产构造点**。
//
// 于是表的 docstring 写着「调用方的集合是更窄的子集，本预言是超集」——**不成立**。
// 反例逐条可复现：`targetForTaskEvent` 只把 `to:'interrupted'` 映到 `interrupt` 事件，
// 而该事件的 allowed-from 是 `['pending','running']`；可修复动作 T1 写
// `to:'interrupted', allowedFrom:['awaiting_review']`，T2 写 `['awaiting_human']`，
// CR-1 写 `['failed']`，S1 写 `['awaiting_review']`，T3 写 `['done']`。
// `nextTaskStatus(from, {kind:'interrupt'})` 对**每一条**都抛 IllegalTaskTransition。
//
// 后果不是「多几条非法写」这么轻：**状态机因此不能被当作预言使用**。可达性分析、
// UI 可用动作、修复动作的前置校验——凡是想「按表推导」的地方，都会得出与生产不符的结论。
//
// 本文件把那句 docstring 变成可执行判据：每个**静态可知**的 `(to, allowedFrom)` 站点，
// 其 `allowedFrom` 必须是「所有以 to 为目标的事件的 allowed-from 之并」的子集，
// 否则必须逐条入偏离账本（只减不增，每条写清为什么这次持久化了一条表说走不通的边）。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  allowedFromForTaskEvent,
  allowedFromStatusesForEvent,
  nextNodeRunStatus,
  targetForTaskEvent,
  NODE_RUN_STATUS,
  type NodeRunStatus,
  type NodeRunTransitionEvent,
  type TaskStatus,
  type TaskTransitionEvent,
} from '@agent-workflow/shared'
import { packageSrcUnits, sourceUnit, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

const TASK_EVENT_KINDS: readonly TaskTransitionEvent['kind'][] = [
  'claim',
  'complete',
  'park-review',
  'park-human',
  'unpark',
  'fail',
  'cancel',
  'interrupt',
  'resume',
  'retry',
  'sync-workflow',
]

const NODE_EVENT_KINDS: readonly NodeRunTransitionEvent['kind'][] = [
  'mark-running',
  'mark-done',
  'mark-failed',
  'mark-canceled',
  'mark-interrupted',
  'park-review',
  'approve-review',
  'iterate-review',
  'reject-review',
  'park-human',
  'resume-clarify',
  'cancel-by-supersede',
  'mark-skipped',
  'mark-exhausted',
]

/** node 侧没有 `targetForNodeRunEvent`——从转移函数上反推（目标与来源无关）。 */
function targetForNodeEvent(kind: NodeRunTransitionEvent['kind']): NodeRunStatus | null {
  for (const from of NODE_RUN_STATUS) {
    try {
      return nextNodeRunStatus(from as NodeRunStatus, {
        kind,
        reason: 'probe',
      } as NodeRunTransitionEvent)
    } catch {
      // 这个来源不合法，换下一个
    }
  }
  return null
}

/** 以 `to` 为目标的所有事件的 allowed-from 之并——表所允许的**最宽**来源集。 */
function taskOracle(to: string): ReadonlySet<string> {
  const out = new Set<string>()
  for (const kind of TASK_EVENT_KINDS) {
    const event = { kind, reason: 'probe' } as TaskTransitionEvent
    if (targetForTaskEvent(event) !== (to as TaskStatus)) continue
    for (const from of allowedFromForTaskEvent(event)) out.add(from)
  }
  return out
}

function nodeOracle(to: string): ReadonlySet<string> {
  const out = new Set<string>()
  for (const kind of NODE_EVENT_KINDS) {
    if (targetForNodeEvent(kind) !== (to as NodeRunStatus)) continue
    for (const from of allowedFromStatusesForEvent({
      kind,
      reason: 'probe',
    } as NodeRunTransitionEvent)) {
      out.add(from)
    }
  }
  return out
}

const TASK_WRITERS = new Set(['setTaskStatus', 'trySetTaskStatus'])
const NODE_WRITERS = new Set(['setNodeRunStatus', 'setNodeRunStatusTx', 'trySetNodeRunStatus'])

interface CasSite {
  readonly file: string
  readonly line: number
  readonly writer: string
  readonly to: string
  readonly allowedFrom: readonly string[]
}

function literalStrings(node: ts.Expression): string[] | null {
  if (!ts.isArrayLiteralExpression(node)) return null
  const out: string[] = []
  for (const element of node.elements) {
    if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
      out.push(element.text)
      continue
    }
    return null
  }
  return out
}

/** 抽出所有**静态可知**的 `(to, allowedFrom)` CAS 站点。 */
export function casSites(units: readonly SourceUnit[]): CasSite[] {
  const sites: CasSite[] = []
  for (const unit of units) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : null
        const arg = node.arguments[0]
        if (
          callee !== null &&
          (TASK_WRITERS.has(callee) || NODE_WRITERS.has(callee)) &&
          arg !== undefined &&
          ts.isObjectLiteralExpression(arg)
        ) {
          let to: string | null = null
          let allowedFrom: string[] | null = null
          for (const prop of arg.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
            if (prop.name.text === 'to') {
              if (ts.isStringLiteral(prop.initializer)) to = prop.initializer.text
            }
            if (prop.name.text === 'allowedFrom') allowedFrom = literalStrings(prop.initializer)
          }
          if (to !== null && allowedFrom !== null) {
            sites.push({
              file: unit.path.replace('packages/backend/src/', ''),
              line: unit.source.getLineAndCharacterOfPosition(node.getStart(unit.source)).line + 1,
              writer: callee,
              to,
              allowedFrom,
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return sites.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`))
}

/** 一个站点里，表说走不通的那些 `from`。 */
export function offTableSources(site: CasSite): string[] {
  const oracle = TASK_WRITERS.has(site.writer) ? taskOracle(site.to) : nodeOracle(site.to)
  return site.allowedFrom.filter((from) => !oracle.has(from)).sort()
}

const key = (site: CasSite): string => `${site.file}:${site.to}`

interface OffTableDeviation {
  /** `file:to` —— 同一文件对同一目标可能有多个站点，按这个粒度记账。 */
  readonly site: string
  /** 表说走不通、而生产确实在写的那些来源。 */
  readonly offTable: readonly string[]
  readonly why: string
}

/**
 * 开账当天（RFC-317 T47）的真实偏离：23 处；provider cutover 把四个
 * TaskExecution composition 写点收进 owner participants 后，当前为 15 处。
 *
 * **全部集中在一件事上**：终态改写。它们与 `allowTerminal` 账本
 * （`rfc317-allow-terminal-ledger.test.ts`）高度重合，这不是巧合——转移表说
 * 「终态没有出边」，而这些站点靠 `allowTerminal: true` 越过那道闸。
 * 本账本记的是**另一半事实**：越过之后它们具体从哪些状态往哪去。
 *
 * 本次**不改任何语义**。修复动作把一条卡住的终态行拉回可续跑、调度器重新认领一条
 * 被打断的 run、评审 supersede 作废一轮已完成的评审——这些都是产品行为，
 * 该不该保留是独立决策。T47 要做的是让「表与生产不一致」这件事**可见且只能减**：
 * 今天谁都说不出「我们有多少条表外边」，于是也没人能判断第 24 条是不是该拦。
 */
const OFF_TABLE_DEVIATIONS: readonly OffTableDeviation[] = [
  {
    site: 'modules/collaboration/infrastructure/legacySqliteClarify/service.ts:done',
    offTable: ['pending'],
    why: 'clarify run 在**还没开跑**时就收到答案：直接从 pending 收成 done，不经过 running。表里 `resume-clarify` 只允许从 awaiting_human 出发。',
  },
  {
    site: 'platform/persistence/sqlite/taskLifecycleRepair/options-CR1.ts:interrupted',
    offTable: ['failed'],
    why: 'CR-1 修复：把误判为 failed 的任务恢复成 interrupted（可续跑）。表里 `interrupt` 只允许从 pending|running 出发——修复动作的存在前提正是「行已经走到了表说不该到的地方」。',
  },
  {
    site: 'platform/persistence/sqlite/taskLifecycleRepair/options-R1.ts:done',
    offTable: ['canceled', 'exhausted', 'failed', 'interrupted', 'pending'],
    why: 'R1 修复：把一条卡住的 node_run 直接收成 done。五个来源覆盖了它可能卡在的所有形态。',
  },
  {
    site: 'platform/persistence/sqlite/taskLifecycleRepair/options-R2.ts:awaiting_review',
    offTable: ['done'],
    why: 'R2 修复：评审行丢失时把 done 的 run 退回 awaiting_review 重新评审。',
  },
  {
    site: 'platform/persistence/sqlite/taskLifecycleRepair/options-S1.ts:interrupted',
    offTable: ['awaiting_review'],
    why: 'S1 修复：卡在评审等待里的任务打回 interrupted。',
  },
  {
    site: 'platform/persistence/sqlite/taskLifecycleRepair/options-S2.ts:interrupted',
    offTable: ['awaiting_human'],
    why: 'S2 修复：卡在人工等待里的任务打回 interrupted。',
  },
  {
    site: 'platform/persistence/sqlite/taskLifecycleRepair/options-S3.ts:pending',
    offTable: ['canceled', 'exhausted', 'failed', 'interrupted'],
    why: 'S3 修复（两处）：把终态 node_run 重置回 pending 以便重跑。',
  },
  {
    site: 'platform/persistence/sqlite/taskLifecycleRepair/options-T1.ts:interrupted',
    offTable: ['awaiting_review'],
    why: 'T1 修复：任务级——评审等待打回 interrupted。',
  },
  {
    site: 'platform/persistence/sqlite/taskLifecycleRepair/options-T1.ts:awaiting_review',
    offTable: ['canceled', 'exhausted', 'failed', 'interrupted'],
    why: 'T1 修复：node 级——终态 run 退回评审等待。',
  },
  {
    site: 'platform/persistence/sqlite/taskLifecycleRepair/options-T2.ts:interrupted',
    offTable: ['awaiting_human'],
    why: 'T2 修复：任务级——人工等待打回 interrupted。',
  },
  {
    site: 'platform/persistence/sqlite/taskLifecycleRepair/options-T2.ts:awaiting_human',
    offTable: ['canceled', 'exhausted', 'failed', 'interrupted'],
    why: 'T2 修复：node 级——终态 run 退回人工等待。',
  },
  {
    site: 'platform/persistence/sqlite/taskLifecycleRepair/options-T3.ts:interrupted',
    offTable: ['done'],
    why: 'T3 修复：把误判为完成的任务打回 interrupted。',
  },
  {
    site: 'platform/persistence/sqlite/taskLifecycleRepair/options-T3.ts:failed',
    offTable: ['done'],
    why: 'T3 修复：把误判为完成的任务打成 failed。表里 `fail` 不接受 done 出发。',
  },
  {
    site: 'modules/collaboration/infrastructure/legacySqliteReview.ts:canceled',
    offTable: ['done'],
    why: '评审 supersede：新一轮评审到来时把上一轮已完成的 run 作废。**这是正常用户流程**——与 lifecycle.ts 头注释「never in normal flows」冲突，见 allowTerminal 账本同址条目。',
  },
  {
    site: 'modules/collaboration/infrastructure/legacySqliteReview.ts:pending',
    offTable: ['awaiting_human', 'done', 'pending', 'running'],
    why: '评审兄弟级联：一条被打回时，同批兄弟 run 一并重置为 pending，无论它们当前处在哪一态。',
  },
]

describe('RFC-317 T47 —— CAS 站点的 allowedFrom 必须能从转移表推出来', () => {
  const units = packageSrcUnits(REPO_ROOT, 'backend')
  const sites = casSites(units)

  test('语料非空：确实抽到了静态可知的 CAS 站点（抽空即假绿）', () => {
    // 这条不可省：下面的判据形如「越界集合等于账本」，抽不到站点时两边都空，满绿。
    expect(units.length).toBeGreaterThan(700)
    expect(sites.length).toBeGreaterThanOrEqual(40)
  })

  test('表内站点确实占多数（判据不是恒真）', () => {
    // 如果 oracle 算错、把所有来源都判成合法，下面那条「越界集合等于账本」会因为
    // 两边都空而假绿。这条从反面钉住：确实有一大批站点被判为**表内**。
    const onTable = sites.filter((site) => offTableSources(site).length === 0)
    expect(onTable.length).toBeGreaterThanOrEqual(20)
  })

  test('越界站点与偏离账本**逐条相等**（新增一条 ⇒ 红；改对一条不销账 ⇒ 也红）', () => {
    const actual = new Map<string, Set<string>>()
    for (const site of sites) {
      const off = offTableSources(site)
      if (off.length === 0) continue
      const bucket = actual.get(key(site)) ?? new Set<string>()
      for (const from of off) bucket.add(from)
      actual.set(key(site), bucket)
    }
    const rendered = [...actual.entries()]
      .map(([site, froms]) => `${site} ← [${[...froms].sort().join(',')}]`)
      .sort()
    const expected = OFF_TABLE_DEVIATIONS.map(
      (entry) => `${entry.site} ← [${[...entry.offTable].sort().join(',')}]`,
    ).sort()
    expect(
      rendered,
      '出现了新的表外边（去 review 里说清为什么这条持久化的 from→to 值得存在），' +
        '或者某条已被改对却没销账——差额会变成下一个人的免费槽位',
    ).toEqual(expected)
  })

  test('每条偏离都写清了理由', () => {
    for (const entry of OFF_TABLE_DEVIATIONS) {
      expect(entry.why.length, `${entry.site}.why`).toBeGreaterThan(20)
      expect(entry.offTable.length, `${entry.site}.offTable`).toBeGreaterThan(0)
    }
  })
})

describe('RFC-317 T47 负向 fixture —— 预言与抽取判据真的会咬', () => {
  test('抽得到 (to, allowedFrom) 站点', () => {
    const sites = casSites([
      sourceUnit(
        'packages/backend/src/x.ts',
        `await setTaskStatus({ db, taskId, to: 'running', allowedFrom: ['pending'] })`,
      ),
    ])
    expect(sites).toHaveLength(1)
    expect(sites[0]?.to).toBe('running')
  })

  test('表内的边不报（pending → running 是 claim 事件）', () => {
    const [site] = casSites([
      sourceUnit(
        'packages/backend/src/x.ts',
        `await setTaskStatus({ db, taskId, to: 'running', allowedFrom: ['pending'] })`,
      ),
    ])
    expect(offTableSources(site!)).toEqual([])
  })

  test('表外的边报出来（done → running 在表里不存在）', () => {
    const [site] = casSites([
      sourceUnit(
        'packages/backend/src/x.ts',
        `await setTaskStatus({ db, taskId, to: 'running', allowedFrom: ['pending', 'done'] })`,
      ),
    ])
    expect(offTableSources(site!)).toEqual(['done'])
  })

  test('node 侧走 node 表（pending → done 在 node 表里不存在）', () => {
    const [site] = casSites([
      sourceUnit(
        'packages/backend/src/x.ts',
        `await setNodeRunStatus({ db, nodeRunId, to: 'done', allowedFrom: ['pending'] })`,
      ),
    ])
    expect(offTableSources(site!)).toEqual(['pending'])
  })

  test('**动态** allowedFrom 抽不到——这是已知盲区，明说而不是假装覆盖', () => {
    // `allowedFrom: SOME_CONST` / `[...spread]` 都逃得过静态抽取。真要覆盖得做类型级
    // 求值，成本远超收益；账本里记的是「静态可知的那 74 个站点」，不是全部写入点。
    expect(
      casSites([
        sourceUnit(
          'packages/backend/src/x.ts',
          `await setTaskStatus({ db, taskId, to: 'running', allowedFrom: SOURCES })`,
        ),
      ]),
    ).toEqual([])
  })
})
