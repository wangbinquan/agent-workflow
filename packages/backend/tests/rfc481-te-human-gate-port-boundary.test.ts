// RFC-481 — task-execution 自有人工门端口：反向越 DAG 类型边清零与开放类型收口（RFC-294 S9 第二步）。
//
// 锁五件事：
// ① task-execution 的全部生产文件不取 collaboration 的任何入口（静态、re-export、type、动态 import 与 require；别名与相对路径都认）。唯一
//    保留的 task-execution → collaboration 边是 `application/adapters/collaboration-adapter.ts` 实现 collaboration 自有 required 端口的那条
//    type import（required-SPI 车道，RFC-294 design §3.1 的虚线），清单精确等于它（带负对照）。
// ② 三组端口类型在 task-execution 声明、从 `public/types` 交出；collaboration 的任何文件不再声明它们，collaboration 的 public 不再交出它们，
//    collaboration 的实现改取 task-execution 的 public。
// ③ 两个帧函数的公开签名里没有函数类型的参数（语法树判定，带负对照）；它们收的两个接口只有方法。
// ④ collaboration 的删除参与者工厂由 `composition.ts` 交出、不在 public，bootstrap 取 composition。
// ⑤ task-execution 的路由依赖与 provider 运行时不再带 `collaboration` 字段（类型层的锁在 rfc359-w12-collaboration-context-contracts）。
//
// 覆盖范围（C12）：① 覆盖 task-execution 的全部生产文件；② 覆盖 collaboration 的全部生产文件与两个模块的 public 文件；③ ④ ⑤ 读指定文件。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const SRC = resolve(import.meta.dir, '..', 'src')
const TE = 'modules/task-execution/'
const CO = 'modules/collaboration/'
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Every module specifier a file references: static, side-effect, re-export, type, dynamic, require. */
const specifiersIn = (text: string) =>
  ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName)

/** Resolve a specifier to a `src/`-relative stem (alias and relative forms), or null. */
function targetOf(fromSrcRelative: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return specifier.slice(2).replace(/\.[cm]?tsx?$/, '')
  if (!specifier.startsWith('.')) return null
  const rel = slash(relative(SRC, resolve(SRC, fromSrcRelative, '..', specifier)))
  return rel.startsWith('..') ? null : rel.replace(/\.[cm]?tsx?$/, '')
}

/** `file -> specifier` for every reference from a task-execution file into collaboration. */
function collaborationReferences(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  return files
    .flatMap(({ path, text }) =>
      specifiersIn(text)
        .filter((specifier) => targetOf(path, specifier)?.startsWith(CO) ?? false)
        .map((specifier) => `${path.slice(TE.length)} -> ${specifier}`),
    )
    .sort()
}

function exportedNames(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (ts.isNamedExports(statement.exportClause))
        names.push(...statement.exportClause.elements.map((element) => element.name.text))
      continue
    }
    const exported = ts.canHaveModifiers(statement)
      ? (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false
    if (!exported) continue
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name !== undefined
    )
      names.push(statement.name.text)
  }
  return [...new Set(names)].sort()
}

/** Names declared (interface / type alias) at the top level of a file, exported or not. */
function declaredTypeNames(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) =>
    ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
      ? [statement.name.text]
      : [],
  )
}

/** Module specifiers of the import declarations that bind `name`. */
function importSourcesOf(path: string, text: string, name: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      return []
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) return []
    return bindings.elements.some((element) => element.name.text === name)
      ? [statement.moduleSpecifier.text]
      : []
  })
}

/** Function-typed nodes inside the parameter list of the named top-level function. */
function callbackParameters(path: string, text: string, fn: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === fn,
  )
  if (declaration === undefined) throw new Error(`${fn} is not declared in ${path}`)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node))
      found.push(node.getText(source))
    ts.forEachChild(node, visit)
  }
  for (const parameter of declaration.parameters) if (parameter.type) visit(parameter.type)
  return found
}

const PORT_TYPES = {
  [`${TE}domain/humanGateContinuation.ts`]: ['PreparedHumanGateRef'],
  [`${TE}application/ports/collaborationRuntimeMechanics.ts`]: [
    'CollaborationAutonomousDismissalInput',
    'CollaborationAutonomousDismissalResult',
    'CollaborationClarifySuppressionInput',
    'CollaborationRuntimeMechanics',
  ],
  [`${TE}application/ports/taskDagCollaborationOperations.ts`]: [
    'TaskDagCollaborationOperations',
    'TaskDagOpenClarifyEvidence',
  ],
} as const
const MOVED = Object.values(PORT_TYPES).flat()
const PUBLIC_ENTRIES = ['commands', 'queries', 'participants', 'types', 'events'] as const

describe('RFC-481 —— task-execution 不取 collaboration（只留 required-SPI 车道）', () => {
  const files = walk(join(SRC, TE)).map((file) => {
    const path = slash(relative(SRC, file))
    return { path, text: readFileSync(file, 'utf8') }
  })

  test('task-execution 的全部生产文件里，指向 collaboration 的只剩实现 collaboration 自有端口的那条 type import', () => {
    expect(files.length).toBeGreaterThanOrEqual(500)
    expect(collaborationReferences(files)).toEqual([
      'application/adapters/collaboration-adapter.ts -> @/modules/collaboration/composition/required-ports',
    ])
    const adapter = files.find(
      (file) => file.path === `${TE}application/adapters/collaboration-adapter.ts`,
    )!
    expect(adapter.text).toMatch(
      /^import type \{[^}]*\} from '@\/modules\/collaboration\/composition\/required-ports'/m,
    )
  })

  test('负对照：判据认得出别名、相对路径、type、re-export、动态 import 与 require', () => {
    const probe = `${TE}application/probe.ts`
    const forms = [
      "import { a } from '@/modules/collaboration/public/participants'",
      "import type { B } from '../../collaboration/public/types'",
      "export { c } from '@/modules/collaboration/public/queries'",
      "const d = await import('@/modules/collaboration/public/commands')",
      "const e = require('../../collaboration/infrastructure/review')",
      "import { f } from '@/modules/task-execution/public/types'",
    ]
    expect(collaborationReferences(forms.map((text) => ({ path: probe, text })))).toEqual([
      'application/probe.ts -> ../../collaboration/infrastructure/review',
      'application/probe.ts -> ../../collaboration/public/types',
      'application/probe.ts -> @/modules/collaboration/public/commands',
      'application/probe.ts -> @/modules/collaboration/public/participants',
      'application/probe.ts -> @/modules/collaboration/public/queries',
    ])
  })
})

describe('RFC-481 —— 人工门端口归 task-execution（design §2）', () => {
  test('三组类型在 task-execution 声明，并从 public/types 交出', () => {
    for (const [path, names] of Object.entries(PORT_TYPES)) {
      const declared = declaredTypeNames(path, read(path))
      for (const name of names)
        expect([path, name, declared.includes(name)]).toEqual([path, name, true])
    }
    const offered = exportedNames(`${TE}public/types.ts`, read(`${TE}public/types.ts`))
    expect(offered).toEqual(expect.arrayContaining([...MOVED]))
  })

  test('collaboration 的生产文件不再声明它们，collaboration 的 public 不再交出它们', () => {
    const collaboration = walk(join(SRC, CO)).map((file) => slash(relative(SRC, file)))
    expect(collaboration.length).toBeGreaterThanOrEqual(150)
    const redeclared = collaboration.flatMap((path) =>
      declaredTypeNames(path, read(path))
        .filter((name) => (MOVED as readonly string[]).includes(name))
        .map((name) => `${path}#${name}`),
    )
    expect(redeclared).toEqual([])
    for (const deleted of [
      'application/ports/collaborationRuntimeMechanics.ts',
      'application/ports/taskDagCollaborationOperations.ts',
    ])
      expect([deleted, existsSync(join(SRC, CO, deleted))]).toEqual([deleted, false])
    const withdrawn = [
      ...MOVED,
      'HumanGateKind',
      'TaskDeletionCollaborationParticipant',
      'createTaskDeletionCollaborationParticipantInTx',
    ]
    for (const entry of PUBLIC_ENTRIES) {
      const path = `${CO}public/${entry}.ts`
      const names = exportedNames(path, read(path))
      expect([path, names.filter((name) => withdrawn.includes(name))]).toEqual([path, []])
    }
    // Positive control: the same reader sees what collaboration's public still hands out.
    expect(
      exportedNames(`${CO}public/participants.ts`, read(`${CO}public/participants.ts`)),
    ).toContain('createWorkgroupClarifyAskGate')
  })

  test('collaboration 的实现、用例与 domain 改取 task-execution 的 public', () => {
    const fromPublic = '@/modules/task-execution/public/types'
    for (const [path, name] of [
      [`${CO}infrastructure/collaborationRuntimeMechanics.ts`, 'CollaborationRuntimeMechanics'],
      [`${CO}infrastructure/taskDagCollaborationOperations.ts`, 'TaskDagCollaborationOperations'],
      [
        `${CO}infrastructure/collaborationWorkgroupClarify.ts`,
        'CollaborationClarifySuppressionInput',
      ],
      [`${CO}domain/humanGateOperation.ts`, 'PreparedHumanGateRef'],
      [`${CO}application/prepareReviewGateOpen.ts`, 'PreparedHumanGateRef'],
      [`${CO}application/prepareClarifyGateOpen.ts`, 'PreparedHumanGateRef'],
    ] as const)
      expect([path, importSourcesOf(path, read(path), name)]).toEqual([path, [fromPublic]])
  })
})

describe('RFC-481 —— 开放类型收口', () => {
  test('两个帧函数的公开签名里没有函数类型的参数', () => {
    expect(
      callbackParameters(
        `${TE}application/frameChain.ts`,
        read(`${TE}application/frameChain.ts`),
        'loadFrameChain',
      ),
    ).toEqual([])
    expect(
      callbackParameters(
        `${TE}domain/environmentChain.ts`,
        read(`${TE}domain/environmentChain.ts`),
        'resolveSourceFrame',
      ),
    ).toEqual([])
  })

  test('它们收的两个接口只有方法（不是函数类型的属性）', () => {
    for (const [path, name, method] of [
      [`${TE}application/frameChain.ts`, 'ContainerRunReader', 'read'],
      [`${TE}domain/environmentChain.ts`, 'ContainerRunLookup', 'get'],
    ] as const) {
      const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
      const declaration = source.statements.find(
        (statement): statement is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(statement) && statement.name.text === name,
      )
      expect([name, declaration?.members.map((member) => member.kind)]).toEqual([
        name,
        [ts.SyntaxKind.MethodSignature],
      ])
      expect(declaration?.members[0]?.name?.getText(source)).toBe(method)
    }
  })

  test('负对照：判据认得出回调参数（含嵌在对象参数里的）', () => {
    const probe = [
      'export function a(read: (id: string) => Promise<number>, frame: number) { return frame }',
      'export function b(args: { readonly lookup: (id: string) => number | undefined }) { return args }',
      'export function c(reader: { read(id: string): number }) { return reader }',
    ].join('\n')
    expect(callbackParameters('probe.ts', probe, 'a')).toEqual(['(id: string) => Promise<number>'])
    expect(callbackParameters('probe.ts', probe, 'b')).toEqual([
      '(id: string) => number | undefined',
    ])
    expect(callbackParameters('probe.ts', probe, 'c')).toEqual([])
  })
})

describe('RFC-481 —— 删除参与者工厂与转手字段', () => {
  test('collaboration 的删除参与者工厂由 composition 交出、不在 public，bootstrap 取 composition', () => {
    expect(exportedNames(`${CO}composition.ts`, read(`${CO}composition.ts`))).toContain(
      'createTaskDeletionCollaborationParticipantInTx',
    )
    const root = 'bootstrap/daemonModules/taskExecution.ts'
    expect(
      importSourcesOf(root, read(root), 'createTaskDeletionCollaborationParticipantInTx'),
    ).toEqual(['@/modules/collaboration/composition'])
  })

  test('task-execution 的路由依赖与 provider 运行时不再带 collaboration 字段', () => {
    for (const [path, name] of [
      [`${TE}infrastructure/taskRouteOperations.ts`, 'TaskRouteOperationsDependencies'],
      [`${TE}composition/providerRuntime.ts`, 'SelectedTaskExecutionProviderRuntime'],
    ] as const) {
      const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
      const declaration = source.statements.find(
        (statement): statement is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(statement) && statement.name.text === name,
      )
      expect(declaration).toBeDefined()
      const members = declaration!.members.map((member) => member.name?.getText(source))
      expect([name, members.includes('collaboration'), members.length > 5]).toEqual([
        name,
        false,
        true,
      ])
    }
  })
})
