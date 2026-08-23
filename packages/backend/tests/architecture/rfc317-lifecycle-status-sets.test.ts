// RFC-317 T51 · findings LC-06 —— 任务状态集合的**单一事实源**。
//
// 这些集合此前是**六份手抄的字面量数组**：
//   · `services/task.ts` 的 `CANCELABLE_TASK_STATUSES`
//   · `task-execution/domain/sourceTermination.ts` 的 `CANCELABLE_STATUSES`（Set 形态）
//   · `task-execution/application/applySourceTerminationEffect.ts` 的 `CANCELABLE`
//   · `services/restore.ts` 的 `NON_TERMINAL_TASK_STATUSES`（**含** interrupted）
//   · `services/worktreeBackup.ts` 的同名数组（同上，但类型写成 `string[]`，
//     用点上还得 `as never` 硬塞进 Drizzle）
//   · `services/stuckTaskDetector.ts` 的一处内联 `inArray(tasks.status, [...])`
//
// 两个真实代价：
//
//  ① **加一个状态不会有任何东西提醒你**。那些数组是字面量类型、仅仅「可赋值给
//     TaskStatus[]」，没有任何机制强制它们覆盖全集。实证：往 `TASK_STATUS` 加
//     `'paused'`，`bun run typecheck` 与全量测试一条不红，而 cancelTask / restore 挂起 /
//     worktree 备份 / 来源终止 / 卡死检测**全都会静默忽略** paused 任务。
//  ② **同名反义**：restore 与 worktreeBackup 的 `NON_TERMINAL_TASK_STATUSES` 把
//     `interrupted` 算作非终态，而 `shared/lifecycle.ts` 的 `TERMINAL_TASK_STATUSES`
//     把它算作终态。同一个名字，隔两个文件意思正好相反。
//
// T51 把它们换成三个派生常量（`CANCELABLE_TASK_STATUSES` / `RESUMABLE_TASK_STATUSES` /
// `LIVE_WORKTREE_TASK_STATUSES`）。本文件锁三件事：
//   ⑴ 派生值**逐条等于**改造前那些手抄数组（证明这次是纯收敛，不是顺手改语义）；
//   ⑵ 集合之间的结构关系成立，且对 `TASK_STATUS` 全集封闭（加状态必须表态）；
//   ⑶ 没有人再在 backend/src 里手抄一份（棘轮 + 负向 fixture）。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  CANCELABLE_TASK_STATUSES,
  LIVE_WORKTREE_TASK_STATUSES,
  RESUMABLE_TASK_STATUSES,
  TASK_STATUS,
  TERMINAL_TASK_STATUSES,
  isTerminalTaskStatus,
  type TaskStatus,
} from '@agent-workflow/shared'
import { packageSrcUnits, sourceUnit, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

describe('RFC-317 T51 —— 派生值等于改造前的手抄值（纯收敛，不改语义）', () => {
  test('可取消集 === 改造前四处手抄的那四个状态', () => {
    // 逐字来自 services/task.ts / sourceTermination.ts / applySourceTerminationEffect.ts /
    // stuckTaskDetector.ts 改造前的字面量。四处当时完全一致。
    expect([...(CANCELABLE_TASK_STATUSES as readonly string[])].sort()).toEqual(
      ['pending', 'running', 'awaiting_review', 'awaiting_human'].sort(),
    )
  })

  test('活工作区集 === 改造前 restore / worktreeBackup 的那五个状态', () => {
    expect([...(LIVE_WORKTREE_TASK_STATUSES as readonly string[])].sort()).toEqual(
      ['running', 'pending', 'awaiting_review', 'awaiting_human', 'interrupted'].sort(),
    )
  })

  test('可 resume 集来自 resume 事件本身（不是手抄，改表即改它）', () => {
    expect([...(RESUMABLE_TASK_STATUSES as readonly string[])].sort()).toEqual(
      ['failed', 'interrupted', 'awaiting_review', 'awaiting_human'].sort(),
    )
  })
})

describe('RFC-317 T51 —— 结构关系与全集封闭', () => {
  test('可取消集与终态集是 TASK_STATUS 的一个**划分**（加状态必须表态）', () => {
    // 这条才是真正防「加了状态没人管」的那道闸：并集等于全集、交集为空。
    // 新增一个 TaskStatus 时，它要么进 `cancel` 事件的 allowed-from，要么进
    // TERMINAL_TASK_STATUSES；两边都不进，这条立刻红。
    const cancelable = new Set<TaskStatus>(CANCELABLE_TASK_STATUSES)
    const terminal = new Set<TaskStatus>(TERMINAL_TASK_STATUSES)
    const unclassified = [...TASK_STATUS].filter((s) => !cancelable.has(s) && !terminal.has(s))
    expect(
      unclassified,
      '新增的任务状态既不可取消也不是终态——cancelTask / restore 挂起 / worktree 备份 / 卡死检测都会静默忽略它',
    ).toEqual([])
    const both = [...TASK_STATUS].filter((s) => cancelable.has(s) && terminal.has(s))
    expect(both, '一个状态同时「可取消」与「终态」——两条判据会互相打架').toEqual([])
  })

  test('活工作区集 = 可取消集 ∪ {interrupted}，且 interrupted 确实是终态', () => {
    expect([...(LIVE_WORKTREE_TASK_STATUSES as readonly string[])].sort()).toEqual(
      [...new Set<string>([...CANCELABLE_TASK_STATUSES, 'interrupted'])].sort(),
    )
    // 这一条把「为什么多这一个」钉住：它是唯一一个已是终态、却从没走过收尾的状态。
    expect(isTerminalTaskStatus('interrupted')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 棘轮：不许再手抄
// ---------------------------------------------------------------------------

/** 一个数组字面量里的字符串元素（含非字符串元素则整条作废——那不是状态清单）。 */
function stringElements(node: ts.ArrayLiteralExpression): string[] | null {
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

const setKey = (values: readonly string[]): string => [...new Set(values)].sort().join('|')

/**
 * 被派生常量取代的那两个集合的指纹。
 *
 * 判据是**集合精确相等**，不是「看起来像一串任务状态」。第一版写成后者，实测在真实语料上
 * 报出 24 处，其中绝大多数是误报：
 *   · `NodeRunStatus` 的清单——两个状态域共用 `pending` / `running` / `done` / `failed`
 *     等字面量，按字符串判根本分不开；
 *   · `db/schema.ts` 里 `text('status', { enum: [...] })` 的**列声明本身**；
 *   · 语义确实不同的子集（`['done','failed','canceled']` 是「可归档」，不是「非终态」）。
 * 一条会报出二十几处误报的规则，最终只会被人加一堆豁免糊住，等于没有。
 */
const REPLACED_SET_KEYS = new Map<string, string>([
  [setKey(CANCELABLE_TASK_STATUSES), 'CANCELABLE_TASK_STATUSES'],
  [setKey(LIVE_WORKTREE_TASK_STATUSES), 'LIVE_WORKTREE_TASK_STATUSES'],
])

interface StatusListExemption {
  readonly site: string
  readonly why: string
  readonly removeWhen: string
}

/**
 * 与派生集合**逐字相同、但确实不是同一个东西**的站点。
 *
 * 每一条都必须说清「为什么它长得一样却不该改 import」——否则豁免就变成了万能出口。
 */
const EXEMPTIONS: readonly StatusListExemption[] = [
  {
    site: 'packages/backend/src/services/lifecycle.ts',
    why: '`SOURCE_TERMINATION_BLOCKED_NODE_STATUSES` 是 **NodeRunStatus** 的集合，不是 TaskStatus。两个状态域恰好共用这四个字面量，但它们分属两台状态机——把它改成 import 任务侧的常量，会在任一侧新增状态时静默串台。',
    removeWhen:
      'node_run 侧也从自己的转移表派生出对应集合（RFC-317 B7 的 T47 会把 node 侧的 allowedFrom 一并纳入表判据），届时这里改 import 那一个。',
  },
  {
    site: 'packages/backend/src/services/lifecycleRepair/options-R1.ts',
    why: '这不是一个状态集合常量，而是一次 `setTaskStatus({ to, allowedFrom })` 调用的**逐调用 allowed-from**。它恰好等于可取消集是巧合；语义是「这条修复动作允许从哪些状态发起」。',
    removeWhen: 'T47（LC-01）把所有 allowedFrom 站点纳入转移表判据后，这里由那条规则接管。',
  },
  {
    site: 'packages/backend/src/services/lifecycleRepair/options-R2.ts',
    why: '同 options-R1 —— 逐调用 allowed-from，不是状态集合常量。',
    removeWhen: '同 options-R1。',
  },
]

/**
 * 报出「手抄了已被派生常量取代的那两个集合」的站点。
 */
export function handCopiedStatusListSites(
  units: readonly SourceUnit[],
  opts: { readonly applyExemptions?: boolean } = {},
): string[] {
  // 默认套用豁免；`applyExemptions:false` 是给「豁免自证」那条用的——不绕过的话，
  // 自证会因为文件先被跳过而恒为 0，看起来永远通过（第一版就是这么写的，被这条抓住）。
  const exempt = new Set(
    (opts.applyExemptions ?? true) ? EXEMPTIONS.map((entry) => entry.site) : [],
  )
  const hits: string[] = []
  for (const unit of units) {
    if (exempt.has(unit.path)) continue
    const visit = (node: ts.Node): void => {
      if (ts.isArrayLiteralExpression(node)) {
        const values = stringElements(node)
        const replaced = values === null ? undefined : REPLACED_SET_KEYS.get(setKey(values))
        if (replaced !== undefined) {
          const line = unit.source.getLineAndCharacterOfPosition(node.getStart(unit.source)).line + 1
          hits.push(`${unit.path}:${line} 应改 import ${replaced}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return hits.sort()
}

describe('RFC-317 T51 棘轮 —— backend/src 不得再手抄这两个集合', () => {
  const units = packageSrcUnits(REPO_ROOT, 'backend')

  test('语料非空（扫空即假绿）', () => {
    expect(units.length).toBeGreaterThan(700)
  })

  test('零手抄站点', () => {
    expect(
      handCopiedStatusListSites(units),
      '又出现了手抄的状态集合——改 import shared 的派生常量',
    ).toEqual([])
  })

  test('每条豁免都写清了 why 与 removeWhen，且指向的文件确实存在', () => {
    const paths = new Set(units.map((unit) => unit.path))
    for (const entry of EXEMPTIONS) {
      expect(paths.has(entry.site), `豁免指向了不存在的文件：${entry.site}`).toBe(true)
      expect(entry.why.length, `${entry.site}.why`).toBeGreaterThan(30)
      expect(entry.removeWhen.length, `${entry.site}.removeWhen`).toBeGreaterThan(10)
    }
  })

  test('豁免不是白送的：撤掉任一条，该文件立刻被报出来（否则它早就该删）', () => {
    // 一条「撤掉也不会红」的豁免说明那个站点已经改好了，留着只会让判据静静变松。
    for (const entry of EXEMPTIONS) {
      const unit = units.find((candidate) => candidate.path === entry.site)
      expect(unit, entry.site).toBeDefined()
      expect(
        handCopiedStatusListSites([unit!], { applyExemptions: false }).length,
        `${entry.site} 已经不含被取代的集合了——这条豁免该删`,
      ).toBeGreaterThan(0)
    }
  })
})

describe('RFC-317 T51 负向 fixture —— 判据真的会咬', () => {
  test('抄全可取消集 ⇒ 报出来，并指名该 import 哪个常量', () => {
    expect(
      handCopiedStatusListSites([
        sourceUnit(
          'packages/backend/src/x.ts',
          `const S = ['pending', 'running', 'awaiting_review', 'awaiting_human']`,
        ),
      ]),
    ).toEqual(['packages/backend/src/x.ts:1 应改 import CANCELABLE_TASK_STATUSES'])
  })

  test('顺序不同也报（判据是集合，不是数组）', () => {
    expect(
      handCopiedStatusListSites([
        sourceUnit(
          'packages/backend/src/x.ts',
          `const S = ['awaiting_human', 'awaiting_review', 'running', 'pending']`,
        ),
      ]),
    ).toHaveLength(1)
  })

  test('抄全活工作区集 ⇒ 指向另一个常量（两个集合不能混）', () => {
    expect(
      handCopiedStatusListSites([
        sourceUnit(
          'packages/backend/src/x.ts',
          `const S = ['pending', 'running', 'awaiting_review', 'awaiting_human', 'interrupted']`,
        ),
      ]),
    ).toEqual(['packages/backend/src/x.ts:1 应改 import LIVE_WORKTREE_TASK_STATUSES'])
  })

  test('**少一个**不报——判据是精确相等，不是「像」', () => {
    // 第一版判据是「≥3 个任务状态字面量」，在真实语料上报出 24 处误报（NodeRunStatus
    // 清单、schema 列声明、语义不同的子集）。宁可漏报一个真子集，也不要一条被豁免糊住的规则。
    expect(
      handCopiedStatusListSites([
        sourceUnit(
          'packages/backend/src/x.ts',
          `const S = ['pending', 'running', 'awaiting_review']`,
        ),
      ]),
    ).toEqual([])
  })

  test('混进非状态字符串不报（那不是这两个集合）', () => {
    expect(
      handCopiedStatusListSites([
        sourceUnit(
          'packages/backend/src/x.ts',
          `const S = ['pending', 'running', 'awaiting_review', 'not-a-status']`,
        ),
      ]),
    ).toEqual([])
  })

  test('读取的是文件真实内容：把常量注释掉不影响判据（AST 不看注释）', () => {
    expect(
      handCopiedStatusListSites([
        sourceUnit(
          'packages/backend/src/x.ts',
          `// const S = ['pending', 'running', 'awaiting_review']\nexport const ok = 1`,
        ),
      ]),
    ).toEqual([])
  })
})
