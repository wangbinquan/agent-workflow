// RFC-533 — 子任务预算由会话构造；调用链深度的热应用恢复（RFC-294 S12 第十四步）。
//
// 锁三件事（design §3 的清单即退出门）：
// ① `infrastructure/childBudget.ts` 顶层没有 `let`，没有导出的 `set*` / `register*` / `reset*` / `bind*`；生产代码不再引用删去的名字；
//    设置的热应用只在 daemon 的 HTTP 装配里调会话预算的 `applyLimits`，实参带容量与深度（语料下限 3,000）。
// ② 行为：两份运行期互不相通；预算未建时放行什么都不做；`applyLimits` 调大容量后已排队的等待者立刻放行、改深度后判据取新值。
// ③ 深度热应用经设置保存的回归用例在 `rfc266-concurrency-hot-apply`（PUT /api/config 之后会话预算的深度取保存值）。
// 负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createChildTaskBudgetRuntime } from '@/modules/task-execution/infrastructure/childBudget'
import type { ChildTaskBudgetQueries } from '@/modules/task-execution/application/ports/childTaskBudgetQueries'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const BUDGET = SRC + 'modules/task-execution/infrastructure/childBudget.ts'
const HTTP = SRC + 'bootstrap/daemonHttpComposition.ts'
const CORPUS_TIMEOUT = 30_000
/** The process hooks RFC-533 removed; production must not name them again. */
const REMOVED = [
  'ensureChildTaskBudget',
  'notifyChildBudgetTaskStatus',
  'setChildTaskBudgetCapacity',
  'setMaxInvocationDepth',
  'resetChildTaskBudgetForTests',
  'currentMaxInvocationDepth',
]
const MUTATOR = /^(set|register|reset|bind)[A-Z]/
const HOT_APPLY =
  'childTaskBudget.applyLimits({maxActiveChildTasks:input.maxActiveChildTasks,maxInvocationDepth:input.maxInvocationDepth})'

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
const exported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)

export function childBudgetViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  const budget = units.find((unit) => unit.path === BUDGET)
  if (budget === undefined) errors.add('missing source: ' + BUDGET)
  else
    for (const statement of budget.source.statements) {
      if (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Let) !== 0
      )
        for (const declaration of statement.declarationList.declarations)
          errors.add('module-level let:' + declaration.name.getText(budget.source))
      if (
        ts.isFunctionDeclaration(statement) &&
        exported(statement) &&
        statement.name !== undefined &&
        MUTATOR.test(statement.name.text)
      )
        errors.add('exported mutator:' + statement.name.text)
    }
  const applied: string[] = []
  for (const unit of units) {
    if (!unit.path.startsWith(SRC)) continue
    walk(unit.source, (node) => {
      if (ts.isIdentifier(node) && REMOVED.includes(node.text))
        errors.add(`removed name:${unit.path}:${node.text}`)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'applyLimits'
      )
        applied.push(
          `${unit.path}:${node
            .getText(unit.source)
            .replace(/\s+/g, '')
            .replace(/,(?=[)}\]])/g, '')}`,
        )
    })
  }
  if (applied.join('\n') !== `${HTTP}:${HOT_APPLY}`)
    errors.add('hot apply:' + (applied.join(' | ') || 'none'))
  return [...errors].sort()
}

describe('RFC-533 ① 预算没有模块级状态；热应用只在 HTTP 装配里推给会话预算', () => {
  test(
    '真实语料：childBudget.ts 没有顶层 let 与导出的 setter / reset，删去的名字不在，热应用带容量与深度',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(childBudgetViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-533 ② 会话预算的行为', () => {
  const queries = (counted: readonly string[] = []) => {
    const isChildTask = mock(async () => true)
    const port: ChildTaskBudgetQueries = {
      listCountedChildTaskIds: async () => [...counted],
      isChildTask,
      parentTaskId: async () => null,
    }
    return { port, isChildTask }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

  test('两份运行期互不相通：各自的预算与容量', async () => {
    const a = createChildTaskBudgetRuntime(queries().port)
    const b = createChildTaskBudgetRuntime(queries().port)
    const budgetA = await a.ensure(() => 1)
    const budgetB = await b.ensure(() => 1)
    expect(budgetA).not.toBe(budgetB)
    expect(await a.ensure(() => 1)).toBe(budgetA)
    await budgetA.acquire([])
    // B's single unit is untouched by A's hold.
    let grantedB = false
    void budgetB.acquire([]).then(() => {
      grantedB = true
    })
    await settle()
    expect(grantedB).toBe(true)
  })

  test('预算未建时生命周期放行什么都不做（不读库）', async () => {
    const { port, isChildTask } = queries()
    const runtime = createChildTaskBudgetRuntime(port)
    runtime.notifyStatus('rfc533-task', 'done')
    await settle()
    expect(isChildTask).not.toHaveBeenCalled()
  })

  test('applyLimits：调大容量当场放行已排队者；深度判据取保存值', async () => {
    const runtime = createChildTaskBudgetRuntime(queries().port)
    expect(runtime.maxInvocationDepth(undefined)).toBe(3)
    expect(runtime.maxInvocationDepth(7)).toBe(7)
    const budget = await runtime.ensure(() => 1)
    await budget.acquire([])
    let granted = false
    void budget.acquire([]).then(() => {
      granted = true
    })
    await settle()
    expect(granted).toBe(false)
    runtime.applyLimits({ maxActiveChildTasks: 2, maxInvocationDepth: 5 })
    await settle()
    expect(granted).toBe(true)
    expect(runtime.maxInvocationDepth(7)).toBe(5)
    expect(runtime.maxInvocationDepth(undefined)).toBe(5)
  })
})

describe('RFC-533 负对照', () => {
  const budget = (text: string) => sourceUnit(BUDGET, text)
  const http = (text: string) => sourceUnit(HTTP, `function apply(input) {\n  ${text}\n}`)
  const clean = [
    budget('export function createChildTaskBudgetRuntime() { let live = null; return { live } }'),
    http(
      'childTaskBudget.applyLimits({ maxActiveChildTasks: input.maxActiveChildTasks, maxInvocationDepth: input.maxInvocationDepth })',
    ),
  ]

  test('伪造的干净语料没有违例（闭包里的 let 不算）', () => {
    expect(childBudgetViolations(clean)).toEqual([])
  })

  test('顶层 let、导出的 setter、删去的名字、漏推深度与别处热应用都会被认出', () => {
    expect(
      childBudgetViolations([
        budget('let singleton = null\nexport function setChildTaskBudgetCapacity(n) {}'),
        clean[1]!,
      ]),
    ).toEqual([
      'exported mutator:setChildTaskBudgetCapacity',
      'module-level let:singleton',
      `removed name:${BUDGET}:setChildTaskBudgetCapacity`,
    ])
    expect(
      childBudgetViolations([
        clean[0]!,
        http('childTaskBudget.applyLimits({ maxActiveChildTasks: input.maxActiveChildTasks })'),
      ]),
    ).toEqual([
      `hot apply:${HTTP}:childTaskBudget.applyLimits({maxActiveChildTasks:input.maxActiveChildTasks})`,
    ])
    expect(
      childBudgetViolations([
        ...clean,
        sourceUnit(
          SRC + 'bootstrap/daemonSession.ts',
          'runtime.childTaskBudget.applyLimits({ maxActiveChildTasks: 1, maxInvocationDepth: 1 })\nnotifyChildBudgetTaskStatus(a, b, c)',
        ),
      ]),
    ).toEqual([
      `hot apply:${HTTP}:${HOT_APPLY} | ${SRC}bootstrap/daemonSession.ts:runtime.childTaskBudget.applyLimits({maxActiveChildTasks:1,maxInvocationDepth:1})`,
      `removed name:${SRC}bootstrap/daemonSession.ts:notifyChildBudgetTaskStatus`,
    ])
  })
})
