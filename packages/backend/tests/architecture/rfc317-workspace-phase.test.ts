// RFC-317 T50 · findings LC-05 —— 「任务工作区处于哪一阶段」只能有一份判据。
//
// 改造前：三个模块各写一份，且其中两份的注释还各自声称「判据与
// `assertWorktreePresentForResume` 同源」——**它们不是**：
//
//   ① services/task.ts          空路径 + workspaceState==='available' + 有 __repo_prep__ 行
//   ② services/autoResume.ts    空路径 + workspacePrunedAt === null
//   ③ services/stuckTaskDetector.ts  同 ②
//
// 分歧的具体后果（finding 的证伪方式逐字可复现）：一条**存量**物化失败的任务行
// ——空路径、无墓碑、也从来没有过 `__repo_prep__` 行（迁移 0034 给它回填了空路径的
// task_repos，迁移 0085 新增墓碑列时不回填）——在三处得到三种结论：
//   · `resumeTask` → 落到 `existsSync('')` → 410「被 worktree GC 回收了」；
//   · `autoResumeInterruptedTasks` → 路由去 `retryRepoPrep()`，**而 AC-11 的重试入口
//     对它根本不存在**，等于把人指向一扇不存在的门；
//   · `stuckTaskDetector` → 把它的 S4 告警静音 45 分钟。
// 三处都绿。
//
// T50 抽出 `taskWorkspacePhase`（shared，纯函数）并统一到 ① 的判据——它是三者里
// 唯一考虑过存量行的。本文件锁两件事：判据的行为，以及「不许有人再手写一份」。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { taskWorkspacePhase } from '@agent-workflow/shared'
import { packageSrcUnits, sourceUnit, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

const row = (over: Partial<Parameters<typeof taskWorkspacePhase>[0]> = {}) => ({
  worktreePath: '/w/t',
  workspacePruningAt: null,
  workspacePrunedAt: null,
  hasRepoPrepRow: false,
  ...over,
})

describe('RFC-317 T50 —— taskWorkspacePhase 的四个相', () => {
  test('墓碑优先：已打墓碑 ⇒ pruned（与有没有准备行无关）', () => {
    expect(taskWorkspacePhase(row({ workspacePrunedAt: 1 }))).toBe('pruned')
    expect(
      taskWorkspacePhase(row({ workspacePrunedAt: 1, worktreePath: '', hasRepoPrepRow: true })),
    ).toBe('pruned')
  })

  test('正在打墓碑 ⇒ pruning —— 改造前 autoResume / stuckTaskDetector **看不见这一相**', () => {
    // 这两处此前只判 `workspacePrunedAt === null`，于是一条正在回收中的任务会被
    // 它们当成「还在准备仓库」：autoResume 去重跑准备、stuck 检测把告警静音。
    expect(taskWorkspacePhase(row({ workspacePruningAt: 1, worktreePath: '' }))).toBe('pruning')
  })

  test('空路径 + 无墓碑 + **有**准备行 ⇒ preparing', () => {
    expect(taskWorkspacePhase(row({ worktreePath: '', hasRepoPrepRow: true }))).toBe('preparing')
  })

  test('空路径 + 无墓碑 + **无**准备行 ⇒ available（存量物化失败行，不是准备中）', () => {
    // 这条是三处分歧的核心。判成 preparing 会把人指向一个对它不存在的重试入口。
    expect(taskWorkspacePhase(row({ worktreePath: '', hasRepoPrepRow: false }))).toBe('available')
  })

  test('有路径 ⇒ available（准备行的存在与否不影响已建好的工作树）', () => {
    expect(taskWorkspacePhase(row({ hasRepoPrepRow: true }))).toBe('available')
  })
})

// ---------------------------------------------------------------------------
// 棘轮：不许再手写这份判据
// ---------------------------------------------------------------------------

interface PhaseOwner {
  readonly file: string
  readonly why: string
}

/**
 * 允许把 `worktreePath === ''` 与墓碑列写进同一个函数的文件。
 *
 * 每条都要说清「为什么它长得像却不是那条判据」——否则这份名单会变成万能出口。
 * 下面那条「豁免必须承重」的自证不是形式主义：本文件初版列了三个 owner，自证当场
 * 报出其中**两条根本不承重**（`taskWorkspacePhase.ts` 压根不含该形态，`task.ts`
 * 改造后也不再共现）。留着它们只会让后来的人以为那两个文件里藏着一份自造判据。
 */
const PHASE_OWNERS: readonly PhaseOwner[] = [
  {
    file: 'packages/backend/src/services/gc.ts',
    why: '这里是**墓碑生命周期的主人**（认领 / 执行 / 治愈前推），不是消费者。它的 `worktreePath === \'\' || !existsSync(...)` 问的是「目录还在不在」，答的是「要不要把行治愈前推」，与「是不是还在准备仓库」是两个问题——后者还要求存在 `__repo_prep__` 行，而 GC 根本不关心那个。',
  },
]

const TOMBSTONE_NAMES = new Set(['workspacePrunedAt', 'workspacePruningAt', 'workspaceState'])

/**
 * 报出「在同一个函数体里既比较 `worktreePath` 又读墓碑列」的站点。
 *
 * 判据是**同一函数内共现**而不是同一文件：一个文件里两件事各自出现是正常的
 * （比如 select 列表列了两列、另一处函数用其中一列），真正危险的是有人在一个函数里
 * 把它们拼成一条自己的相判定。
 */
export function handWrittenPhasePredicates(
  units: readonly SourceUnit[],
  opts: { readonly applyOwners?: boolean } = {},
): string[] {
  const hits: string[] = []
  const owners = new Set(
    (opts.applyOwners ?? true) ? PHASE_OWNERS.map((entry) => entry.file) : [],
  )
  for (const unit of units) {
    if (owners.has(unit.path)) continue
    const scanBody = (body: ts.Node, label: string): void => {
      let comparesEmptyWorktree = false
      let readsTombstone = false
      const walk = (node: ts.Node): void => {
        // 只认 `worktreePath === ''`（「还没建出来」），**不认 `!==`**。
        // 后者是存在性检查，prune/GC 机制本身到处在用（`finishClaimedWorkspacePrune`
        // 判目录还在不在、`setTaskStatus` 的工作区复活闸），那些函数当然也读墓碑列——
        // 把它们一起报出来只会逼人加一堆豁免，判据就此失去意义。
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        ) {
          const text = node.getText(unit.source)
          if (/worktreePath\s*===\s*''/.test(text)) comparesEmptyWorktree = true
        }
        if (ts.isPropertyAccessExpression(node) && TOMBSTONE_NAMES.has(node.name.text)) {
          readsTombstone = true
        }
        ts.forEachChild(node, walk)
      }
      walk(body)
      if (comparesEmptyWorktree && readsTombstone) {
        const line = unit.source.getLineAndCharacterOfPosition(body.getStart(unit.source)).line + 1
        hits.push(`${unit.path}:${line} ${label}`)
      }
    }
    const visit = (node: ts.Node): void => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)) &&
        node.body !== undefined
      ) {
        const name =
          ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
            ? (node.name?.getText(unit.source) ?? '<anonymous>')
            : '<anonymous>'
        scanBody(node.body, name)
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return hits.sort()
}

describe('RFC-317 T50 棘轮 —— 只有一处可以拼这条判据', () => {
  const units = packageSrcUnits(REPO_ROOT, 'backend')

  test('语料非空（扫空即假绿）', () => {
    expect(units.length).toBeGreaterThan(700)
  })

  test('每条豁免都承重：撤掉它，那个文件立刻被报出来（否则该删）', () => {
    for (const owner of PHASE_OWNERS) {
      const unit = units.find((candidate) => candidate.path === owner.file)
      expect(unit, `豁免指向了不存在的文件：${owner.file}`).toBeDefined()
      expect(owner.why.length, `${owner.file}.why`).toBeGreaterThan(30)
      expect(
        handWrittenPhasePredicates([unit!], { applyOwners: false }).length,
        `${owner.file} 已经不含该形态了——这条豁免该删`,
      ).toBeGreaterThan(0)
    }
  })

  test('零手写站点', () => {
    expect(
      handWrittenPhasePredicates(units),
      '有人又在一个函数里把 worktreePath 与墓碑列拼成自己的相判定——改用 shared 的 taskWorkspacePhase',
    ).toEqual([])
  })
})

describe('RFC-317 T50 负向 fixture —— 判据真的会咬', () => {
  test('同一函数内共现 ⇒ 报出来', () => {
    expect(
      handWrittenPhasePredicates([
        sourceUnit(
          'packages/backend/src/x.ts',
          `export function f(t: any) { return t.worktreePath === '' && t.workspacePrunedAt === null }`,
        ),
      ]),
    ).toHaveLength(1)
  })

  test('分处两个函数 ⇒ 不报（那是正常的分工，不是一条自造判据）', () => {
    expect(
      handWrittenPhasePredicates([
        sourceUnit(
          'packages/backend/src/x.ts',
          `export function a(t: any) { return t.worktreePath === '' }\n` +
            `export function b(t: any) { return t.workspacePrunedAt }`,
        ),
      ]),
    ).toEqual([])
  })

  test('只读墓碑列（不比较空路径）⇒ 不报', () => {
    expect(
      handWrittenPhasePredicates([
        sourceUnit(
          'packages/backend/src/x.ts',
          `export function f(t: any) { return t.workspacePruningAt !== null }`,
        ),
      ]),
    ).toEqual([])
  })

  test('账本里的文件被豁免（否则墓碑机制的主人会报自己）', () => {
    const fixture = sourceUnit(
      'packages/backend/src/services/gc.ts',
      `export function f(t: any) { return t.worktreePath === '' && t.workspacePrunedAt === null }`,
    )
    expect(handWrittenPhasePredicates([fixture])).toEqual([])
    // 而绕过豁免时它必须被报出来——否则「豁免承重」那条自证就成了空转。
    expect(handWrittenPhasePredicates([fixture], { applyOwners: false })).toHaveLength(1)
  })
})
