// RFC-599 — 员工工作区与平台工作项装配的效果选择必填（RFC-294 S12 余项）。
//
// 为什么存在：development-automation 的员工工作区（`composeDevelopmentEmployeeWorkspace`）与平台工作项（`composeDevelopmentEmployeePlatformWorkItems`）
// 两个装配的效果选择原是可选成员，没给时 infrastructure 的 `select*` 造本机文件实现；daemon 两处都给全，靠缺省的只有用例。现在三个成员必填。
// 锁两件事：
// ① 两个装配入参接口里 `automationWorkspaceEffects`（与平台工作项的 `repositoryBaselines`）没有 `?`；编译期断言它们是必填键（判据带负对照）。
// ② 两个装配文件里对这两个入参的读取只是 `selectedAutomationWorkspaceEffects` / `createGitBaselineReader` 的实参，都不在条件或回落里（判据带负对照）。
//
// 覆盖范围（C12）：只读两个装配文件；调用方由 `tsc` 全量核对。行为由调用这两个装配的用例覆盖（它们显式给本机实现）。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import type { DevelopmentEmployeeWorkspaceCompositionInput } from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import type { DevelopmentEmployeePlatformWorkItemsCompositionInput } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'

const COMPOSITION = join(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'development-automation',
  'composition',
)
const FILES = {
  workspace: {
    path: join(COMPOSITION, 'digitalEmployeeWorkspace.ts'),
    input: 'DevelopmentEmployeeWorkspaceCompositionInput',
    members: ['automationWorkspaceEffects'],
  },
  platform: {
    path: join(COMPOSITION, 'digitalEmployeePlatformWorkItems.ts'),
    input: 'DevelopmentEmployeePlatformWorkItemsCompositionInput',
    members: ['automationWorkspaceEffects', 'repositoryBaselines'],
  },
} as const
const SELECTIONS = new Set(['automationWorkspaceEffects', 'repositoryBaselines'])

// ① Compile-time: an optional key makes the empty object fit its `Pick`, so these are `true` only when the keys are required.
type IsRequired<T, K extends keyof T> = Record<never, never> extends Pick<T, K> ? never : true
const workspaceRequired: IsRequired<
  DevelopmentEmployeeWorkspaceCompositionInput,
  'automationWorkspaceEffects'
> = true
const platformRequired: [
  IsRequired<DevelopmentEmployeePlatformWorkItemsCompositionInput, 'automationWorkspaceEffects'>,
  IsRequired<DevelopmentEmployeePlatformWorkItemsCompositionInput, 'repositoryBaselines'>,
] = [true, true]

const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

/** The named members of one interface, as `name` or `name?`. */
function members(path: string, text: string, name: string, wanted: readonly string[]): string[] {
  const source = parse(path, text)
  const node = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  )
  return (node?.members ?? [])
    .filter((member) => wanted.includes(member.name?.getText(source) ?? ''))
    .map((member) => member.name!.getText(source) + (member.questionToken ? '?' : ''))
    .sort()
}

/** Whether a node sits in a condition, a fallback (`??` / `||`) or a comparison before its statement ends. */
function conditional(node: ts.Node): boolean {
  for (
    let child = node, parent = node.parent;
    parent !== undefined;
    child = parent, parent = parent.parent
  ) {
    if (ts.isConditionalExpression(parent) && parent.condition === child) return true
    if (ts.isIfStatement(parent) && parent.expression === child) return true
    if (
      ts.isBinaryExpression(parent) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(parent.operatorToken.kind)
    )
      return true
    if (ts.isStatement(parent)) return false
  }
  return false
}

/** Each read of `input.<selection>`: the call it feeds, or where it sits instead. */
function selectionReads(path: string, text: string): string[] {
  const source = parse(path, text)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText(source) === 'input' &&
      SELECTIONS.has(node.name.text)
    ) {
      const call = node.parent
      found.push(
        conditional(node)
          ? `input.${node.name.text} in a condition or fallback`
          : ts.isCallExpression(call) && call.arguments.includes(node)
            ? `${call.expression.getText(source)}(… input.${node.name.text})`
            : `input.${node.name.text} outside a call`,
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found.sort()
}

describe('RFC-599 —— 员工工作区与平台工作项装配的效果选择必填', () => {
  test('两个装配入参接口里的效果选择都没有 ?', () => {
    for (const file of Object.values(FILES))
      expect(members(file.path, readFileSync(file.path, 'utf8'), file.input, file.members)).toEqual(
        [...file.members],
      )
    expect([workspaceRequired, ...platformRequired]).toEqual([true, true, true])
  })

  test('负对照：可选成员会被认出，别的接口与别的成员不算', () => {
    expect(
      members(
        'probe.ts',
        'interface DevelopmentEmployeePlatformWorkItemsCompositionInput {\n' +
          '  readonly automationWorkspaceEffects?: A\n' +
          '  readonly repositoryBaselines: B\n' +
          '  readonly now?: () => number\n' +
          '}\n' +
          'interface Other {\n  readonly repositoryBaselines?: B\n}\n',
        'DevelopmentEmployeePlatformWorkItemsCompositionInput',
        FILES.platform.members,
      ),
    ).toEqual(['automationWorkspaceEffects?', 'repositoryBaselines'])
  })

  test('装配只把效果选择交给核对与使用它们的调用', () => {
    expect(
      selectionReads(FILES.workspace.path, readFileSync(FILES.workspace.path, 'utf8')),
    ).toEqual(['selectedAutomationWorkspaceEffects(… input.automationWorkspaceEffects)'])
    expect(selectionReads(FILES.platform.path, readFileSync(FILES.platform.path, 'utf8'))).toEqual([
      'createGitBaselineReader(… input.repositoryBaselines)',
      'selectedAutomationWorkspaceEffects(… input.automationWorkspaceEffects)',
    ])
  })

  test('负对照：回落、条件与调用外的读取都会被认出', () => {
    expect(
      selectionReads(
        'probe.ts',
        'const factory = input.automationWorkspaceEffects ?? createLocal()\n' +
          'const baselines = input.repositoryBaselines === undefined ? local : input.repositoryBaselines\n' +
          'const checked = selectedAutomationWorkspaceEffects(input.automationWorkspaceEffects)\n',
      ),
    ).toEqual([
      'input.automationWorkspaceEffects in a condition or fallback',
      'input.repositoryBaselines in a condition or fallback',
      'input.repositoryBaselines outside a call',
      'selectedAutomationWorkspaceEffects(… input.automationWorkspaceEffects)',
    ])
  })
})
