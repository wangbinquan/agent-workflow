// RFC-600 — development-automation 的 infrastructure 不再替调用方造本机效果（RFC-294 S12 余项：单机默认值只留在 standalone profile）。
//
// 为什么存在：RFC-598、RFC-599 之后装配都显式给出效果选择，但 infrastructure 里的核对函数与收可选工厂的包装仍在“没给”时自己造本机文件实现；
// 生产上靠这条回落的只有托管任务镜像里的执行器（它在镜像里对自己的文件操作，本来就该用本机实现）。现在核对函数只核对、工厂参数都必填，
// 执行器显式给本机实现。锁三件事：
// ① 两个核对函数（`selectedAutomationWorkspaceEffects`、`selectActionWorkspaceEffects`）不调用本机构造、不以 `undefined` 为条件；基线读取没有
//    `selectedRepositoryBaselineEffects`（判据带负对照）。
// ② development-automation 的 infrastructure 与 composition 全部源码里，类型是效果工厂的函数参数都不带 `?`、不并 `undefined`（判据带负对照）。
// ③ backend 全部生产源码里调用三个本机效果构造的文件恰好是 standalone profile、本机一族自身与镜像里的执行器（判据带负对照）。
//
// 覆盖范围（C12）：① 读三个文件；② 扫 development-automation 的 infrastructure 与 composition 全部源码（≥ 70）；③ 扫 backend 全部生产源码（≥ 3000）。
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const SRC = join(import.meta.dir, '..', 'src')
const DA = join(SRC, 'modules', 'development-automation')
const LOCAL_CONSTRUCTORS = new Set([
  'createFileAutomationWorkspaceEffectsFactory',
  'createFileActionWorkspaceEffects',
  'createFileRepositoryBaselineEffectsFactory',
])
const FACTORY_TYPE =
  /\b(?:AutomationWorkspaceEffectsFactory|ActionWorkspaceEffects|RepositoryBaselineEffectsFactory)\b/
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

/**
 * In each named function: the local constructors it calls and the comparisons of its own parameter with `undefined` (a
 * member compared with `undefined`, as a completeness check does, is not a fallback).
 */
function checkFallbacks(path: string, text: string, names: readonly string[]): string[] {
  const source = parse(path, text)
  const found: string[] = []
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || !names.includes(statement.name?.text ?? ''))
      continue
    const name = statement.name!.text
    const parameters = new Set(
      statement.parameters.map((parameter) => parameter.name.getText(source)),
    )
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        LOCAL_CONSTRUCTORS.has(node.expression.text)
      )
        found.push(`${name} calls ${node.expression.text}`)
      if (
        ts.isBinaryExpression(node) &&
        [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
          node.operatorToken.kind,
        ) &&
        [node.left, node.right].some((side) => side.getText(source) === 'undefined') &&
        [node.left, node.right].some((side) => parameters.has(side.getText(source)))
      )
        found.push(`${name} compares its parameter with undefined`)
      ts.forEachChild(node, visit)
    }
    visit(statement)
  }
  return found
}

/** Function parameters whose type is an effects factory and that are optional or take `undefined`. */
function optionalFactoryParameters(path: string, text: string): string[] {
  const source = parse(path, text)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isParameter(node) &&
      node.type !== undefined &&
      FACTORY_TYPE.test(node.type.getText(source))
    ) {
      const optional =
        node.questionToken !== undefined ||
        node.initializer !== undefined ||
        (ts.isUnionTypeNode(node.type) &&
          node.type.types.some((member) => member.kind === ts.SyntaxKind.UndefinedKeyword))
      if (optional)
        found.push(
          `${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${node.getText(source)}`,
        )
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Whether a file calls one of the local effect constructors. */
function callsLocalConstructor(path: string, text: string): boolean {
  if (![...LOCAL_CONSTRUCTORS].some((name) => text.includes(name))) return false
  const source = parse(path, text)
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      LOCAL_CONSTRUCTORS.has(node.expression.text)
    )
      found = true
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('RFC-600 —— development-automation 的 infrastructure 不再替调用方造本机效果', () => {
  test('两个核对函数只核对；基线读取没有回落函数', () => {
    const automation = join(DA, 'infrastructure', 'automationWorkspaceEffects.ts')
    const action = join(DA, 'infrastructure', 'actionWorkspaceEffects.ts')
    expect([
      ...checkFallbacks(automation, readFileSync(automation, 'utf8'), [
        'selectedAutomationWorkspaceEffects',
      ]),
      ...checkFallbacks(action, readFileSync(action, 'utf8'), ['selectActionWorkspaceEffects']),
    ]).toEqual([])
    expect(readFileSync(join(DA, 'infrastructure', 'gitBaselineReader.ts'), 'utf8')).not.toContain(
      'selectedRepositoryBaselineEffects',
    )
  })

  test('负对照：本机构造的调用与参数和 undefined 的比较都会被认出，成员的完整性核对与别的函数不算', () => {
    expect(
      checkFallbacks(
        'probe.ts',
        'export function selectedAutomationWorkspaceEffects(factory) {\n' +
          '  if (factory === undefined) return createFileAutomationWorkspaceEffectsFactory()\n' +
          "  if (factory.contents === undefined) throw new Error('incomplete')\n" +
          '  return factory\n' +
          '}\n' +
          'export function other(x) {\n  return x === undefined ? createFileActionWorkspaceEffects() : x\n}\n',
        ['selectedAutomationWorkspaceEffects'],
      ),
    ).toEqual([
      'selectedAutomationWorkspaceEffects compares its parameter with undefined',
      'selectedAutomationWorkspaceEffects calls createFileAutomationWorkspaceEffectsFactory',
    ])
  })

  test('infrastructure 与 composition 里效果工厂的参数都必填', () => {
    const files = [
      ...walk(join(DA, 'infrastructure')),
      ...walk(join(DA, 'composition')),
      join(DA, 'composition.ts'),
    ]
    expect(files.length).toBeGreaterThanOrEqual(70)
    expect(
      files.flatMap((path) =>
        optionalFactoryParameters(path, readFileSync(path, 'utf8')).map(
          (found) => `${slash(relative(SRC, path))}:${found}`,
        ),
      ),
    ).toEqual([])
  })

  test('负对照：带 ?、带缺省与并 undefined 的工厂参数都会被认出，别的类型不算', () => {
    expect(
      optionalFactoryParameters(
        'probe.ts',
        'export function a(factory?: AutomationWorkspaceEffectsFactory) {}\n' +
          'export function b(factory: RepositoryBaselineEffectsFactory | undefined) {}\n' +
          'export function c(effects: ActionWorkspaceEffects = local()) {}\n' +
          'export function d(factory: AutomationWorkspaceEffectsFactory, name?: string) {}\n',
      ),
    ).toEqual([
      '1: factory?: AutomationWorkspaceEffectsFactory',
      '2: factory: RepositoryBaselineEffectsFactory | undefined',
      '3: effects: ActionWorkspaceEffects = local()',
    ])
  })

  test('生产代码里只有 standalone profile、本机一族与镜像里的执行器调用本机效果构造', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThanOrEqual(3000)
    expect(
      files
        .filter((path) => callsLocalConstructor(path, readFileSync(path, 'utf8')))
        .map((path) => slash(relative(SRC, path)))
        .sort(),
    ).toEqual([
      'bootstrap/standalone.ts',
      'modules/development-automation/infrastructure/crewstation/taskImageWorkspace.ts',
      'modules/development-automation/infrastructure/local/fileActionWorkspaceEffects.ts',
    ])
  })

  test('负对照：调用会被认出，import、转出与只提到名字都不算', () => {
    expect(
      [
        "import { createFileActionWorkspaceEffects } from './local'\nexport const a = createFileActionWorkspaceEffects()\n",
        "export { createFileActionWorkspaceEffects } from './local'\n",
        '// createFileRepositoryBaselineEffectsFactory() is the local one\n',
      ].map((text) => callsLocalConstructor('probe.ts', text)),
    ).toEqual([true, false, false])
  })
})
