// RFC-499 — 源代码管理的发布传输与仓库准备的 effect 实现归 infrastructure（RFC-294 S10 第六步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件里只在清单列的文件声明（`sessionOf` 另有 intent 一个无关的私有同名函数，逐个钉住），各文件只声明、
//    只交出清单的名字；两个被删的密钥文件解析在全部生产文件、用例与 e2e 里没有声明、import 与调用（带负对照）。
// ② 传输：`composition/repositoryPublicationTransport.ts` 不存在；`composition.ts` 从新文件只转出 `createRepositoryPublicationTransport`、
//    不取 `node:fs`；全部生产文件、用例与 e2e 不从旧位置取任何东西：命名 import、type-only、默认与副作用 import、re-export、命名空间
//    成员与动态 import 都认（带负对照）。
// ③ 准备：`composition/repositoryPreparation.ts` 只声明装配函数、只从本机文件转出三个名字，没有控制流语句；装配函数恰好一次调用
//    `createRepositoryPreparationBridge`，交出的对象恰好是 `...input` 与两组 effect、各一处回落到对应的本机工厂；准备绑定的两组 effect
//    必填、文件里不出现本机工厂（带负对照）。
// ④ 三个新文件不取任何模块的 composition（本模块 `composition/required-ports` 的 type-only import 除外，与同目录既有 infrastructure
//    文件一致）；传输不取 `node:fs`（带负对照）。
//
// 覆盖范围（C12）：① ② 读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字或路径文本筛、再逐个解析
// AST；③ ④ 读 `composition.ts`、装配文件与三个新文件。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const SC = 'modules/source-control'
const OLD_TRANSPORT = `${SC}/composition/repositoryPublicationTransport`
const TRANSPORT = `${SC}/infrastructure/repositoryPublicationTransport`
const LOCAL = `${SC}/infrastructure/local/repositoryPreparation`
const BRIDGE = `${SC}/infrastructure/repositoryPreparationBridge`
const ASSEMBLY = `${SC}/composition/repositoryPreparation`
const MODULE_COMPOSITION = `${SC}/composition`
const REQUIRED_PORTS = `${SC}/composition/required-ports`
const INTENT_PERSISTENCE = 'modules/intent/infrastructure/intentSqlPersistence'

/** design §3: what each file declares and what it offers (the assembly also forwards the local file's three names). */
const LISTED = new Map<string, { readonly declared: string[]; readonly offered: string[] }>([
  [
    TRANSPORT,
    {
      declared: [
        'baseMatchesHost',
        'isLocalRepositoryRemote',
        'connectionMayOwnRemote',
        'legacySession',
        'sessionOf',
        'usernameFor',
        'discoverEndpointCandidate',
        'createRepositoryPublicationTransport',
      ],
      offered: ['createRepositoryPublicationTransport'],
    },
  ],
  [
    LOCAL,
    {
      declared: [
        'RepositoryPreparationInput',
        'composeLocalRepositoryPreparationEffects',
        'composeLocalScratchWorkspaceEffects',
      ],
      offered: [
        'RepositoryPreparationInput',
        'composeLocalRepositoryPreparationEffects',
        'composeLocalScratchWorkspaceEffects',
      ],
    },
  ],
  [
    BRIDGE,
    {
      declared: ['createRepositoryPreparationBridge'],
      offered: ['createRepositoryPreparationBridge'],
    },
  ],
  [
    ASSEMBLY,
    {
      declared: ['composeRepositoryPreparation'],
      offered: [
        'composeRepositoryPreparation',
        'RepositoryPreparationInput',
        'composeLocalRepositoryPreparationEffects',
        'composeLocalScratchWorkspaceEffects',
      ],
    },
  ],
])
/** Same-name top-level declarations that already existed elsewhere and are unrelated (pinned one by one). */
const PINNED = new Map<string, string[]>([['sessionOf', [INTENT_PERSISTENCE]]])
/** design D3: deleted, with no caller anywhere. */
const DELETED = [
  'resolveRepositoryPublicationTransportFromKeyFile',
  'resolveRepositoryTransportCredentialsFromKeyFile',
]
/** design D2: what the assembly hands the binding, in source order (whitespace removed). */
const ASSEMBLY_FIELDS = [
  '...input',
  'scratchEffects: input.scratchEffects??composeLocalScratchWorkspaceEffects(input)',
  'preparationEffects: input.preparationEffects??composeLocalRepositoryPreparationEffects(input)',
]
/** The tests below read every production file, test and e2e file; the first pays the cold read. */
const CORPUS_TIMEOUT = 30_000

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}
const PRODUCTION = walk(SRC)
const TEST_FILES = walk(join(BACKEND, 'tests'))
const E2E_FILES = walk(join(REPO, 'e2e'))
const TEXTS = new Map<string, string>()
const text = (path: string) => {
  let content = TEXTS.get(path)
  if (content === undefined) TEXTS.set(path, (content = readFileSync(path, 'utf8')))
  return content
}
const srcPath = (abs: string) => slash(relative(SRC, abs)).replace(/\.tsx?$/, '')
const sourceOf = (location: string) => join(SRC, `${location}.ts`)
/** `@/…` and relative specifiers as a path under `src` without extension; packages yield null. */
const resolveSpecifier = (file: string, specifier: string) =>
  specifier.startsWith('@/')
    ? srcPath(join(SRC, specifier.slice(2)))
    : specifier.startsWith('.')
      ? srcPath(resolve(dirname(file), specifier))
      : null

function declaredNames(path: string, source: string): string[] {
  const names: string[] = []
  for (const statement of parse(path, source).statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    )
      names.push(statement.name.text)
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
  }
  return names
}

function offeredNames(path: string, source: string): string[] {
  const names: string[] = []
  for (const statement of parse(path, source).statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (exported) names.push(...declaredNames(path, statement.getFullText()))
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements) names.push(element.name.text)
  }
  return names
}

/** `export … from` declarations of the file: where each points (resolved under `src`) and the names it forwards. */
function forwards(path: string, source: string): string[] {
  const out: string[] = []
  for (const statement of parse(path, source).statements)
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const target =
        resolveSpecifier(path, statement.moduleSpecifier.text) ?? statement.moduleSpecifier.text
      const clause = statement.exportClause
      const names =
        clause !== undefined && ts.isNamedExports(clause)
          ? clause.elements.map((element) => (element.propertyName ?? element.name).text)
          : ['*']
      for (const name of names) out.push(`${target}: ${name}`)
    }
  return out
}

/** Every call of `name` in the file, as parsed nodes. */
function callsOf(file: ts.SourceFile, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}
/** `name: initializer` (whitespace removed) for each property of an object literal; spreads as `...expression`. */
function literalShape(file: ts.SourceFile, node: ts.Expression | undefined): string[] {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return ['<not an object literal>']
  return node.properties.map((property) =>
    ts.isSpreadAssignment(property)
      ? `...${property.expression.getText(file)}`
      : ts.isPropertyAssignment(property)
        ? `${property.name.getText(file)}: ${property.initializer.getText(file).replace(/\s+/g, '')}`
        : property.getText(file),
  )
}
/** The statements of the top-level function `fn`, whitespace collapsed; null when absent. */
function bodyOf(path: string, source: string, fn: string): string[] | null {
  const file = parse(path, source)
  const declaration = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === fn,
  )
  return (
    declaration?.body?.statements.map((statement) =>
      statement.getText(file).replace(/\s+/g, ' '),
    ) ?? null
  )
}
/**
 * The member `member` of the first parameter's type of the top-level function `fn`, looked up in a type literal or in
 * the type-literal parts of an intersection: optional or not, null when absent.
 */
function parameterMemberOptional(
  path: string,
  source: string,
  fn: string,
  member: string,
): boolean | null {
  const declaration = parse(path, source).statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === fn,
  )
  const type = declaration?.parameters[0]?.type
  const literals =
    type === undefined
      ? []
      : ts.isIntersectionTypeNode(type)
        ? type.types.filter(ts.isTypeLiteralNode)
        : ts.isTypeLiteralNode(type)
          ? [type]
          : []
  const found = literals
    .flatMap((literal) => [...literal.members])
    .find((candidate) => candidate.name?.getText() === member)
  return found === undefined ? null : found.questionToken !== undefined
}
/** How many identifiers named `name` the file has (declarations, calls and references alike). */
function identifierCount(path: string, source: string, name: string): number {
  let count = 0
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name) count++
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return count
}
/** Statement-level control flow (the F13 measure): if / for / while / do / switch / try / throw. */
function controlFlow(path: string, source: string): string[] {
  const found: string[] = []
  const file = parse(path, source)
  const visit = (node: ts.Node) => {
    if (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isTryStatement(node) ||
      ts.isThrowStatement(node)
    )
      found.push(
        `${ts.SyntaxKind[node.kind]}@${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`,
      )
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/**
 * `file -> old location: what` for everything a file still takes from the deleted transport file (design §4 ②): named
 * import, type-only, default and side-effect import, `export … from` and `export * from`, members of a namespace import
 * (value and type positions), and dynamic `import()` with its destructured names; specifiers resolve from the file.
 */
function takenFromOldLocation(file: string, source: string): string[] {
  const out: string[] = []
  const label = slash(relative(REPO, file))
  const fromOld = (specifier: string) => resolveSpecifier(file, specifier) === OLD_TRANSPORT
  const flag = (what: string) => out.push(`${label} -> ${OLD_TRANSPORT}: ${what}`)
  const namespaces = new Set<string>()
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      fromOld(node.moduleSpecifier.text)
    ) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        if (clause === undefined) flag('<side effect>')
        if (clause?.name !== undefined) flag('default')
        const bindings = clause?.namedBindings
        if (bindings !== undefined && ts.isNamedImports(bindings))
          for (const element of bindings.elements) flag((element.propertyName ?? element.name).text)
        if (bindings !== undefined && ts.isNamespaceImport(bindings))
          namespaces.add(bindings.name.text)
      } else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause))
        for (const element of node.exportClause.elements)
          flag((element.propertyName ?? element.name).text)
      else flag('*')
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      fromOld(node.arguments[0].text)
    )
      flag('import()')
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined
    ) {
      let call: ts.Expression = node.initializer
      if (ts.isAwaitExpression(call)) call = call.expression
      if (
        ts.isCallExpression(call) &&
        call.expression.kind === ts.SyntaxKind.ImportKeyword &&
        call.arguments[0] !== undefined &&
        ts.isStringLiteral(call.arguments[0]) &&
        fromOld(call.arguments[0].text)
      )
        for (const element of node.name.elements)
          flag((element.propertyName ?? element.name).getText())
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    )
      flag(node.name.text)
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && namespaces.has(node.left.text))
      flag(node.right.text)
    ts.forEachChild(node, visit)
  }
  // Namespace imports are statements at the top, so one pass sees the binding before its members.
  visit(parse(file, source))
  return out
}

/** `file: name` for every identifier named after a deleted function (declarations, imports and calls alike). */
function deletedNameUses(file: string, source: string): string[] {
  const label = slash(relative(REPO, file))
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && DELETED.includes(node.text)) out.push(`${label}: ${node.text}`)
    ts.forEachChild(node, visit)
  }
  visit(parse(file, source))
  return out
}

const FS = /^(?:node:)?fs(?:\/promises)?$/
/**
 * Imports of any module's composition (static, `export … from` and dynamic); a type-only import of this module's
 * `composition/required-ports` is the one exception (design §4 ④). With `noFs`, `fs` imports are findings too.
 */
function compositionFindings(file: string, source: string, noFs: boolean): string[] {
  const findings: string[] = []
  const check = (specifier: string, typeOnly: boolean, how: string) => {
    if (noFs && FS.test(specifier)) findings.push(`${how} ${specifier}`)
    const target = resolveSpecifier(file, specifier)
    if (target === null || !/^modules\/[^/]+\/composition(?:\/|$)/.test(target)) return
    if (target === REQUIRED_PORTS && typeOnly) return
    findings.push(`${how} ${specifier}`)
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause !== undefined
    )
      check(node.moduleSpecifier.text, node.importClause.isTypeOnly, 'import')
    else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      check(node.moduleSpecifier.text, false, 'import')
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      check(node.moduleSpecifier.text, node.isTypeOnly, 'export')
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    )
      check(node.arguments[0].text, false, 'import()')
    ts.forEachChild(node, visit)
  }
  visit(parse(file, source))
  return findings
}

describe('RFC-499 ① 清单里的名字只在清单列的文件声明，被删的函数没有任何引用', () => {
  test(
    '全部生产文件里每个名字只在清单列的文件声明（语料下限 3,000；早已存在的无关同名声明逐个钉住）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      for (const [location, { declared }] of LISTED)
        for (const name of declared) {
          const declaring = PRODUCTION.filter(
            (path) =>
              new RegExp(`\\b${name}\\b`).test(text(path)) &&
              declaredNames(path, text(path)).includes(name),
          )
            .map(srcPath)
            .sort()
          expect([name, declaring]).toEqual([name, [location, ...(PINNED.get(name) ?? [])].sort()])
        }
    },
    CORPUS_TIMEOUT,
  )

  test('各文件只声明清单的名字、只交出清单的名字', () => {
    for (const [location, { declared, offered }] of LISTED) {
      const path = sourceOf(location)
      expect([location, declaredNames(path, text(path)).sort()]).toEqual([
        location,
        [...declared].sort(),
      ])
      expect([location, offeredNames(path, text(path)).sort()]).toEqual([
        location,
        [...offered].sort(),
      ])
    }
  })

  test(
    '两个被删的函数在全部生产文件、用例（语料下限 2,500）与 e2e 里没有声明、import 与调用',
    () => {
      expect(TEST_FILES.length).toBeGreaterThanOrEqual(2500)
      expect(E2E_FILES.length).toBeGreaterThan(0)
      expect(
        [...PRODUCTION, ...TEST_FILES, ...E2E_FILES]
          .filter((path) => DELETED.some((name) => text(path).includes(name)))
          .flatMap((path) => deletedNameUses(path, text(path))),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：声明、import、转出与调用都会被认出，字符串与注释里的名字不算', () => {
    const file = join(SRC, `${SC}/composition/probe.ts`)
    const source = [
      `export function resolveRepositoryPublicationTransportFromKeyFile() {}`,
      `import { resolveRepositoryTransportCredentialsFromKeyFile } from '../composition'`,
      `export { resolveRepositoryPublicationTransportFromKeyFile as again } from './elsewhere'`,
      `resolveRepositoryTransportCredentialsFromKeyFile(repository, keyFile)`,
      `const named = 'resolveRepositoryPublicationTransportFromKeyFile'`,
      `// resolveRepositoryTransportCredentialsFromKeyFile`,
    ].join('\n')
    const label = slash(relative(REPO, file))
    expect(deletedNameUses(file, source)).toEqual(
      [
        'resolveRepositoryPublicationTransportFromKeyFile',
        'resolveRepositoryTransportCredentialsFromKeyFile',
        'resolveRepositoryPublicationTransportFromKeyFile',
        'resolveRepositoryTransportCredentialsFromKeyFile',
      ].map((name) => `${label}: ${name}`),
    )
    expect(declaredNames(file, `function sessionOf() {}\nexport const other = 1`)).toEqual([
      'sessionOf',
      'other',
    ])
  })
})

describe('RFC-499 ② 发布传输归 infrastructure，没有文件从旧位置取任何东西', () => {
  const compositionPath = sourceOf(MODULE_COMPOSITION)

  test('旧文件不存在；composition.ts 从新文件只转出 createRepositoryPublicationTransport，不取 node:fs', () => {
    expect(existsSync(sourceOf(OLD_TRANSPORT))).toBe(false)
    expect(existsSync(join(SRC, `${OLD_TRANSPORT}.tsx`))).toBe(false)
    const fromTransport = forwards(compositionPath, text(compositionPath)).filter((entry) =>
      entry.startsWith(`${TRANSPORT}: `),
    )
    expect(fromTransport).toEqual([`${TRANSPORT}: createRepositoryPublicationTransport`])
    expect(
      compositionFindings(compositionPath, text(compositionPath), true).filter((finding) =>
        FS.test(finding.split(' ')[1] ?? ''),
      ),
    ).toEqual([])
  })

  test(
    '全部生产文件、用例与 e2e 不从旧位置取任何东西',
    () => {
      expect(
        [...PRODUCTION, ...TEST_FILES, ...E2E_FILES]
          .filter((path) => /repositoryPublicationTransport/.test(text(path)))
          .flatMap((path) => takenFromOldLocation(path, text(path))),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：命名、type-only、默认与副作用 import、re-export、命名空间成员与动态 import 都会被认出，新位置不算', () => {
    const file = join(SRC, `${SC}/composition.probe.ts`)
    const source = [
      `import { createRepositoryPublicationTransport } from './composition/repositoryPublicationTransport'`,
      `import type { RepositoryPublicationTransport } from '@/${OLD_TRANSPORT}'`,
      `import transport from './composition/repositoryPublicationTransport'`,
      `import './composition/repositoryPublicationTransport'`,
      `export { legacySession } from '@/${OLD_TRANSPORT}'`,
      `export * from './composition/repositoryPublicationTransport'`,
      `import * as old from '@/${OLD_TRANSPORT}'`,
      `const create = old.createRepositoryPublicationTransport`,
      `const typed: old.Transport | undefined = undefined`,
      `const { sessionOf } = await import('./composition/repositoryPublicationTransport')`,
      `export { createRepositoryPublicationTransport as moved } from './infrastructure/repositoryPublicationTransport'`,
      `const later = await import('@/${TRANSPORT}')`,
    ].join('\n')
    const label = slash(relative(REPO, file))
    expect(takenFromOldLocation(file, source)).toEqual(
      [
        'createRepositoryPublicationTransport',
        'RepositoryPublicationTransport',
        'default',
        '<side effect>',
        'legacySession',
        '*',
        'createRepositoryPublicationTransport',
        'Transport',
        'sessionOf',
        'import()',
      ].map((what) => `${label} -> ${OLD_TRANSPORT}: ${what}`),
    )
    expect(
      forwards(
        join(SRC, `${SC}/composition.ts`),
        [
          `export { createRepositoryPublicationTransport, extra } from './infrastructure/repositoryPublicationTransport'`,
          `export * from './infrastructure/repositoryPublicationTransport'`,
        ].join('\n'),
      ),
    ).toEqual([
      `${TRANSPORT}: createRepositoryPublicationTransport`,
      `${TRANSPORT}: extra`,
      `${TRANSPORT}: *`,
    ])
  })
})

describe('RFC-499 ③ 准备的 composition 只留装配，准备绑定的两组 effect 必填', () => {
  const assemblyPath = sourceOf(ASSEMBLY)
  const bridgePath = sourceOf(BRIDGE)

  test('装配文件只从本机文件转出三个名字，没有控制流语句', () => {
    expect(forwards(assemblyPath, text(assemblyPath)).sort()).toEqual(
      [
        `${LOCAL}: composeLocalRepositoryPreparationEffects`,
        `${LOCAL}: composeLocalScratchWorkspaceEffects`,
        `${LOCAL}: RepositoryPreparationInput`,
      ].sort(),
    )
    expect(controlFlow(assemblyPath, text(assemblyPath))).toEqual([])
  })

  test('装配函数恰好一次建绑定：交出 ...input 与两组 effect，各一处回落到对应的本机工厂；两组 effect 照旧可选', () => {
    const file = parse(assemblyPath, text(assemblyPath))
    const calls = callsOf(file, 'createRepositoryPreparationBridge')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.arguments).toHaveLength(1)
    expect(literalShape(file, calls[0]!.arguments[0])).toEqual(ASSEMBLY_FIELDS)
    const body = bodyOf(assemblyPath, text(assemblyPath), 'composeRepositoryPreparation')
    expect(body).toHaveLength(1)
    expect(body![0]!.startsWith('return createRepositoryPreparationBridge(')).toBe(true)
    for (const member of ['preparationEffects', 'scratchEffects'])
      expect(
        parameterMemberOptional(
          assemblyPath,
          text(assemblyPath),
          'composeRepositoryPreparation',
          member,
        ),
      ).toBe(true)
    expect(callsOf(file, 'composeLocalScratchWorkspaceEffects')).toHaveLength(1)
    expect(callsOf(file, 'composeLocalRepositoryPreparationEffects')).toHaveLength(1)
  })

  test('准备绑定的两组 effect 必填，文件里不出现本机工厂', () => {
    for (const member of ['preparationEffects', 'scratchEffects'])
      expect(
        parameterMemberOptional(
          bridgePath,
          text(bridgePath),
          'createRepositoryPreparationBridge',
          member,
        ),
      ).toBe(false)
    for (const local of [
      'composeLocalRepositoryPreparationEffects',
      'composeLocalScratchWorkspaceEffects',
    ])
      expect(identifierCount(bridgePath, text(bridgePath), local)).toBe(0)
  })

  test('负对照：控制流、多余或缺少的回落、可选的 effect 与绑定里的本机工厂都会被认出', () => {
    const probe = join(SRC, `${SC}/composition/probe.ts`)
    const source = [
      `export function composeRepositoryPreparation(input: RepositoryPreparationInput & { readonly scratchEffects?: X }) {`,
      `  if (input.db === undefined) throw new Error('db')`,
      `  for (const item of []) {}`,
      `  try { work() } catch {}`,
      `  return createRepositoryPreparationBridge({ ...input, scratchEffects: input.scratchEffects, extra: composeLocalScratchWorkspaceEffects(input) })`,
      `}`,
      `export function createRepositoryPreparationBridge(input: RepositoryPreparationInput & { readonly preparationEffects?: Y }) {`,
      `  const scratch = input.scratchEffects ?? composeLocalScratchWorkspaceEffects(input)`,
      `}`,
    ].join('\n')
    expect(controlFlow(probe, source)).toEqual([
      'IfStatement@2',
      'ThrowStatement@2',
      'ForOfStatement@3',
      'TryStatement@4',
    ])
    const file = parse(probe, source)
    expect(
      literalShape(file, callsOf(file, 'createRepositoryPreparationBridge')[0]!.arguments[0]),
    ).toEqual([
      '...input',
      'scratchEffects: input.scratchEffects',
      'extra: composeLocalScratchWorkspaceEffects(input)',
    ])
    expect(bodyOf(probe, source, 'composeRepositoryPreparation')).toHaveLength(4)
    expect(
      parameterMemberOptional(probe, source, 'composeRepositoryPreparation', 'preparationEffects'),
    ).toBeNull()
    expect(
      parameterMemberOptional(
        probe,
        source,
        'createRepositoryPreparationBridge',
        'preparationEffects',
      ),
    ).toBe(true)
    expect(identifierCount(probe, source, 'composeLocalScratchWorkspaceEffects')).toBe(2)
  })
})

describe('RFC-499 ④ 新文件不取 composition，传输不取 node:fs', () => {
  test('三个新文件只以 type-only 取本模块的 composition/required-ports；传输不取 node:fs', () => {
    for (const location of [TRANSPORT, LOCAL, BRIDGE]) {
      const path = sourceOf(location)
      expect([location, compositionFindings(path, text(path), location === TRANSPORT)]).toEqual([
        location,
        [],
      ])
    }
  })

  test('负对照：本模块与他模块的 composition、值 import 的 required-ports、动态 import 与 node:fs 都会被认出', () => {
    const file = join(SRC, `${SC}/infrastructure/probe.ts`)
    const source = [
      `import type { RepositoryWorkspaceTaskPorts } from '../composition/required-ports'`,
      `import { RepositoryWorkspaceTaskPortsValue } from '../composition/required-ports'`,
      `import { composeRepositoryPreparation } from '../composition/repositoryPreparation'`,
      `import type { RepositoryWorkspaceStore } from '../composition'`,
      `import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'`,
      `export { selectRepositoryWorkspaceReadQueries } from '../composition/repositoryWorkspaceReadQueries'`,
      `import { readFileSync } from 'node:fs'`,
      `import { readFile } from 'fs/promises'`,
      `import { journal } from './repositoryPreparationJournal'`,
      `const later = await import('../composition/workspaceMaintenance')`,
    ].join('\n')
    expect(compositionFindings(file, source, true)).toEqual([
      'import ../composition/required-ports',
      'import ../composition/repositoryPreparation',
      'import ../composition',
      'import @/modules/task-execution/composition',
      'export ../composition/repositoryWorkspaceReadQueries',
      'import node:fs',
      'import fs/promises',
      'import() ../composition/workspaceMaintenance',
    ])
    expect(compositionFindings(file, source, false)).toHaveLength(6)
  })
})
