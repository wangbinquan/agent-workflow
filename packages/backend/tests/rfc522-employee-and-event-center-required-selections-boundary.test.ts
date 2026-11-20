// RFC-522 — 数字员工与事件中心的适配器回落改为必填注入（RFC-294 S12 第三步）。
//
// 锁三件事（design §3 的清单即退出门；回落本身由 RFC-521 门的登记锁住）：
// ① 两个组合函数的选项里这 5 个属性存在且必填（语法树里不带 `?`），`writerInstallation` 不再是选项；
// ② 全部生产文件（下限 3,000）里没有 `selectLocalCustomObserverProgramFactory` 的声明或转出；event-center 的 infrastructure 只以类型取
//    `composition/required-ports`，不取组合层的值；
// ③ 两个测试助手给出与此前缺省相同的选择：数字员工的三个工厂与实参逐个相同（语法树），事件中心的观察者以原文错误拒绝、自定义观察者工厂是
//    本机实现。带负对照。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { standaloneEventCenterSelections } from './helpers/eventCenter'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, source: string) =>
  ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
      return /\.tsx?$/.test(entry.name) ? [path] : []
    })
}
const PRODUCTION = walk(SRC)
const TEXTS = new Map<string, string>()
const text = (path: string) => {
  let content = TEXTS.get(path)
  if (content === undefined) TEXTS.set(path, (content = readFileSync(path, 'utf8')))
  return content
}
/** The corpus test reads every production file; the first read is cold (CI shards measured 6.3 s against the default 5 s). */
const CORPUS_TIMEOUT = 30_000
const srcPath = (path: string) => slash(relative(SRC, path)).replace(/\.tsx?$/, '')

const DIGITAL_EMPLOYEE = join(SRC, 'modules', 'digital-employee', 'composition.ts')
const EVENT_CENTER = join(SRC, 'modules', 'event-center', 'composition.ts')
/** design §3: the interfaces and the properties that are now required. */
const REQUIRED: readonly (readonly [string, string, readonly string[]])[] = [
  [DIGITAL_EMPLOYEE, 'DigitalEmployeeCompositionOptions', ['inputArtifacts', 'programArtifacts']],
  [DIGITAL_EMPLOYEE, 'ComposeDigitalEmployeeOptions', ['writerCutover']],
  [DIGITAL_EMPLOYEE, 'ComposePostgresqlDigitalEmployeeOptions', ['writerCutover']],
  [EVENT_CENTER, 'ComposeEventCenterOptions', ['observer', 'customObserverPrograms']],
]

/** Each property signature of the interface, and whether it is optional. */
function interfaceProperties(path: string, source: string, name: string): Map<string, boolean> {
  const file = parse(path, source)
  const properties = new Map<string, boolean>()
  const visit = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name)
      for (const member of node.members)
        if (ts.isPropertySignature(member))
          properties.set(member.name.getText(file), member.questionToken !== undefined)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return properties
}

/** Whether the file declares or re-exports `name` (function, variable, class or export specifier). */
function declaresOrExports(path: string, source: string, name: string): boolean {
  const file = parse(path, source)
  let found = false
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name)
      found = true
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
      found = true
    if (ts.isExportSpecifier(node) && node.name.text === name) found = true
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** Imports of a module-internal file that reach the module's composition layer, except type-only imports of its required ports. */
function compositionImports(path: string, source: string): string[] {
  const file = parse(path, source)
  const found: string[] = []
  for (const statement of file.statements) {
    const declaration =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement : null
    if (declaration === null || declaration.moduleSpecifier === undefined) continue
    if (!ts.isStringLiteral(declaration.moduleSpecifier)) continue
    const specifier = declaration.moduleSpecifier.text
    if (!/(^|\/)composition(\/|\.ts$|$)/.test(specifier)) continue
    const typeOnly = ts.isImportDeclaration(declaration)
      ? declaration.importClause?.isTypeOnly === true
      : declaration.isTypeOnly
    if (typeOnly && /\/composition\/required-ports$/.test(specifier)) continue
    found.push(specifier)
  }
  return found
}

/** The argument texts (whitespace removed) of every call of `name` in the file. */
function callArguments(path: string, source: string, name: string): string[][] {
  const file = parse(path, source)
  const calls: string[][] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      calls.push(node.arguments.map((argument) => argument.getText(file).replace(/\s+/g, '')))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}

describe('RFC-522 ① 选项必填', () => {
  test('5 个属性存在且必填；writerInstallation 不再是选项', () => {
    for (const [path, name, properties] of REQUIRED) {
      const found = interfaceProperties(path, text(path), name)
      for (const property of properties)
        expect([name, property, found.get(property)]).toEqual([name, property, false])
    }
    expect(
      interfaceProperties(
        DIGITAL_EMPLOYEE,
        text(DIGITAL_EMPLOYEE),
        'ComposeDigitalEmployeeOptions',
      ).has('writerInstallation'),
    ).toBe(false)
  })

  test('负对照：可选属性、必填属性与缺失属性分得开', () => {
    const found = interfaceProperties(
      join(SRC, 'probe.ts'),
      'export interface P { readonly a?: string; readonly b: string }',
      'P',
    )
    expect([found.get('a'), found.get('b'), found.has('c')]).toEqual([true, false, false])
  })
})

describe('RFC-522 ② 选择助手与组合层依赖', () => {
  test(
    '生产代码里没有 selectLocalCustomObserverProgramFactory；event-center 的 infrastructure 不取组合层的值（语料下限 3,000）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      for (const name of [
        'selectLocalCustomObserverProgramFactory',
        'createUnavailableEventObserverProgram',
      ])
        expect([
          name,
          PRODUCTION.filter(
            (path) => text(path).includes(name) && declaresOrExports(path, text(path), name),
          ).map(srcPath),
        ]).toEqual([name, []])
      const infrastructure = PRODUCTION.filter((path) =>
        srcPath(path).startsWith('modules/event-center/infrastructure/'),
      )
      expect(infrastructure.length).toBeGreaterThan(0)
      expect(
        infrastructure.flatMap((path) =>
          compositionImports(path, text(path)).map((specifier) => `${srcPath(path)}: ${specifier}`),
        ),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：声明、转出与组合层的值 import 都会被认出，required-ports 的类型 import 不算', () => {
    const probe = join(SRC, 'probe.ts')
    expect(declaresOrExports(probe, 'export function pick() {}', 'pick')).toBe(true)
    expect(declaresOrExports(probe, "export { pick } from './x'", 'pick')).toBe(true)
    expect(declaresOrExports(probe, 'export const other = 1', 'pick')).toBe(false)
    expect(
      compositionImports(
        probe,
        [
          "import { a } from '../composition/customObserverProgram'",
          "import type { B } from '../composition/required-ports'",
          "import { c } from '../composition/required-ports'",
          "import { d } from '../application/x'",
        ].join('\n'),
      ),
    ).toEqual(['../composition/customObserverProgram', '../composition/required-ports'])
  })
})

describe('RFC-522 ③ 测试助手与此前的缺省相同', () => {
  test('数字员工：同一组工厂、同一组实参', () => {
    const helper = join(BACKEND, 'tests', 'helpers', 'digitalEmployeeSelections.ts')
    const source = text(helper)
    expect(callArguments(helper, source, 'createEmployeeInputArtifactStore')).toEqual([
      ["join(input.appHome,'artifacts','employee-inputs')"],
    ])
    expect(callArguments(helper, source, 'createProgramArtifactStore')).toEqual([['input.appHome']])
    expect(callArguments(helper, source, 'composeDigitalEmployeeWriterCutoverFor')).toEqual([
      ['input.db'],
    ])
  })

  test('事件中心：观察者以原文错误拒绝，自定义观察者工厂是本机实现', async () => {
    const selections = standaloneEventCenterSelections()
    for (const [source, id] of [
      [{ observerProgramRef: { id: 'program-1' }, sourceRef: { id: 'source-1' } }, 'program-1'],
      [{ sourceRef: { id: 'source-2' } }, 'source-2'],
    ] as const) {
      const error = await selections.observer.run({ source } as never).then(
        () => null,
        (rejected: unknown) => rejected,
      )
      expect((error as Error).message).toBe(`observer program unavailable: ${id}`)
    }
    expect(typeof selections.customObserverPrograms.create).toBe('function')
    // The helper calls the same two factories, without arguments, as the composition used to.
    const helper = join(BACKEND, 'tests', 'helpers', 'eventCenter.ts')
    expect(callArguments(helper, text(helper), 'createUnavailableEventObserverProgram')).toEqual([
      [],
    ])
    expect(callArguments(helper, text(helper), 'createLocalCustomObserverProgramFactory')).toEqual([
      [],
    ])
    expect(standaloneEventCenterSelections().observer).not.toBe(selections.observer)
  })
})
