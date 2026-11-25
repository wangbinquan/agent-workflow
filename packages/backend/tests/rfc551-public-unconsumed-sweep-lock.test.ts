// RFC-551 — identity-access 与 source-control 的未消费 public 符号清零（RFC-294 S9 第七步）。
//
// 锁五件事：
// ① 撤空的 identity-access `public/events.ts` 不在；backend 的 src / 用例 / 脚本、仓根脚本与 e2e 零 import 它（`preProcessFile` 取全部模块
//    引用，别名与相对路径都认，带负对照）。
// ② 被撤出的符号（`tests/fixtures/rfc551-withdrawn-public-symbols.json`：bb34878c7 时两个 context public 文件的导出里、撤出后不在的逐名
//    清单）不在原 public 文件的导出里，值也不在运行时命名空间里；每个仍在的 public 文件带一个仍交出的正对照。
// ③ 直接声明在 public、只有本模块在用的声明按内容落进模块内部（design §2）：在新位置导出、不在本模块任一 public 文件里；source-control 的
//    凭据选择结果落在 domain，domain 不取 application；identity-access 的用户操作合同仍声明在 public、只以 type-only 取 application 的输入
//    schema。
// ④ 回归（design §1 的判据修正）：架构报告的类型形状遍历把类的非 private / protected 构造参数属性当作实例成员——只经 public 类的这种成员
//    引用的类型算作被消费；private / protected 参数属性与普通构造参数不算（fixture，带负对照）。
// ⑤ 减速带：两个 context 的未消费计数上限为 0，全部 context 都是 0（实测由 rfc376-structural-guards 的计数门做，全仓每个 context）。
//
// 覆盖范围（C12）：① 覆盖 backend 的 src / 用例 / 脚本、仓根脚本与 e2e；② ③ 覆盖两个 context 的全部 public 文件；④ 只在 fixture 上判定；
// ⑤ 的计数覆盖全部 context。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { corpusPublicContract, unconsumedPublicSymbols } from './architecture/architectureReport'
import { sourceUnit } from './architecture/census'
import { createGateCorpus } from './architecture/rfc294Gates'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

const CONTEXTS = ['identity-access', 'source-control'] as const
type Context = (typeof CONTEXTS)[number]
type Entry = 'commands' | 'queries' | 'participants' | 'types' | 'events' | 'operations'
const ENTRIES: readonly Entry[] = [
  'commands',
  'queries',
  'participants',
  'types',
  'events',
  'operations',
]

const FIXTURE = JSON.parse(
  readFileSync(join(TESTS, 'fixtures', 'rfc551-withdrawn-public-symbols.json'), 'utf8'),
) as {
  readonly retired: readonly string[]
  readonly withdrawn: Readonly<Record<Context, Partial<Record<Entry, readonly string[]>>>>
}
const RETIRED = FIXTURE.retired.map((path) => path.replace(/\.ts$/, ''))

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Every module specifier a file references: static (incl. empty `import {}`), side-effect, re-export, type, dynamic, require. */
const specifiersIn = (text: string) =>
  ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName)

/** Resolve an import specifier to a `src/`-relative path stem (alias and relative forms), or null. */
function targetOf(from: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return specifier.slice(2).replace(/\.[cm]?tsx?$/, '')
  if (!specifier.startsWith('.')) return null
  const rel = slash(relative(SRC, resolve(from, '..', specifier)))
  return rel.startsWith('..') ? null : rel.replace(/\.[cm]?tsx?$/, '')
}

const importsOf = (files: readonly string[]) =>
  files.flatMap((path) =>
    specifiersIn(readFileSync(path, 'utf8'))
      .filter((specifier) => RETIRED.includes(targetOf(path, specifier) ?? ''))
      .map((specifier) => `${slash(relative(REPO_ROOT, path))} -> ${specifier}`),
  )

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
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    )
      names.push(statement.name.text)
  }
  return [...new Set(names)].sort()
}

/** The import declarations of a file: specifier and whether the whole clause is type-only. */
function importClauses(
  path: string,
  text: string,
): Array<{ specifier: string; typeOnly: boolean }> {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      ? [
          {
            specifier: statement.moduleSpecifier.text,
            typeOnly: statement.importClause?.isTypeOnly === true,
          },
        ]
      : [],
  )
}

const publicFile = (context: Context, entry: Entry) => `modules/${context}/public/${entry}.ts`
const publicExportsOf = (context: Context) =>
  ENTRIES.flatMap((entry) => {
    const file = publicFile(context, entry)
    return existsSync(join(SRC, file)) ? exportedNames(file, read(file)) : []
  })

const IA = 'modules/identity-access/'
const SC = 'modules/source-control/'

/** design §2: declarations that lived in a public file and now live in the module, by content. */
const MOVED: Readonly<Record<string, readonly string[]>> = {
  [IA + 'application/ports/identityAccessEventSink.ts']: [
    'AuthorityRevisionChanged',
    'IdentityAccessEventSink',
  ],
  [IA + 'application/userOperationDescriptors.ts']: [
    'IdentityUserOperationDeps',
    'createIdentityUserOperations',
  ],
  [IA + 'application/view.ts']: ['AdminUserAccessView'],
  [SC + 'application/ports/repositoryTransportCredentials.ts']: [
    'OwnRepositoryTransportCredentialCommands',
    'OwnRepositoryTransportCredentialQueries',
    'RepositoryTransportCredentialSelectionParticipant',
  ],
  [SC + 'application/ports/repositoryCommit.ts']: [
    'RepositoryCommitCandidateParticipant',
    'RepositoryCommitPublicationParticipant',
    'RepositoryPublishMode',
    'RepositoryPublishResult',
  ],
  [SC + 'application/ports/repositoryEndpointDiscovery.ts']: [
    'RepositoryEndpointDiscoveryParticipant',
  ],
  // The selection result is what the domain's credential rules produce; the selection port takes it from there.
  [SC + 'domain/repositoryTransportCredential.ts']: ['RepositoryTransportCredentialSelection'],
}

describe('RFC-551 —— 撤空的 identity-access public/events', () => {
  test('文件不在', () => {
    expect(RETIRED).toEqual([IA + 'public/events'])
    expect(existsSync(join(SRC, `${RETIRED[0]}.ts`))).toBe(false)
  })

  test('backend 的 src、用例与脚本、仓根脚本与 e2e 零 import 它', () => {
    const sources = walk(SRC)
    expect(sources.length).toBeGreaterThanOrEqual(1500)
    expect(importsOf(sources)).toEqual([])
    expect(importsOf(walk(TESTS))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'packages', 'backend', 'scripts')))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'scripts')))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'e2e')))).toEqual([])
    // 逐个解析 backend src、用例、两处脚本目录与 e2e 的全部源码；60 s 是负载下的墙钟允许量，不是对扫描变慢的容忍。
  }, 60_000)

  test('负对照：判据认得出别名、相对路径、type 与动态 import', () => {
    const probe = join(TESTS, 'probe.test.ts')
    expect(targetOf(probe, '../src/modules/identity-access/public/events')).toBe(
      IA + 'public/events',
    )
    expect(targetOf(join(SRC, IA, 'public', 'probe.ts'), './events')).toBe(IA + 'public/events')
    expect(targetOf(probe, '@/modules/identity-access/public/events')).toBe(IA + 'public/events')
    expect(targetOf(probe, '@/modules/identity-access/public/eventsExtra')).not.toBe(
      IA + 'public/events',
    )
    expect(
      specifiersIn(
        "const events = await import('../src/modules/identity-access/public/events')\n" +
          "import type { IdentityAccessEventSink } from '@/modules/identity-access/public/events'\n",
      ).sort(),
    ).toEqual([
      '../src/modules/identity-access/public/events',
      '@/modules/identity-access/public/events',
    ])
  })
})

describe('RFC-551 —— 未消费符号撤出两个 context 的 public', () => {
  test('清单逐名不在原 public 文件的导出里，值也不在运行时命名空间里', async () => {
    let listed = 0
    for (const context of CONTEXTS) {
      for (const entry of ENTRIES) {
        const names = FIXTURE.withdrawn[context]?.[entry] ?? []
        if (names.length === 0) continue
        listed += names.length
        const path = publicFile(context, entry)
        const exported = exportedNames(path, read(path))
        const namespace = (await import(join(SRC, path))) as Record<string, unknown>
        for (const name of names) {
          expect([path, name, exported.includes(name)]).toEqual([path, name, false])
          expect([path, name, name in namespace]).toEqual([path, name, false])
        }
      }
    }
    // bb34878c7: 17 unconsumed (two misreported) plus the cascades, minus the names of the retired events file.
    expect(listed).toBe(29)
  })

  test('正对照：同一读法看得见每个仍在的 public 文件仍交出的符号', async () => {
    const kept: ReadonlyArray<readonly [string, string, boolean]> = [
      [IA + 'public/commands.ts', 'UpdateOwnProfile', true],
      [IA + 'public/operations.ts', 'DrizzleOidcProviderRepository', true],
      [IA + 'public/queries.ts', 'GetUserProfile', true],
      [IA + 'public/types.ts', 'UserAccessError', true],
      [SC + 'public/commands.ts', 'WorkspaceClaimFinalizationCommand', false],
      [SC + 'public/participants.ts', 'bindRepositoryGitWorkspace', true],
      // RFC-565: `existingRepositoryIds` left the public (it took a database handle); the control names a value still there.
      [SC + 'public/queries.ts', 'selectRepositoryWorkspaceReadQueries', true],
      [SC + 'public/types.ts', 'RepositoryTransportCredentialError', true],
    ]
    const withNames = CONTEXTS.flatMap((context) =>
      ENTRIES.filter((entry) => (FIXTURE.withdrawn[context]?.[entry] ?? []).length > 0).map(
        (entry) => publicFile(context, entry),
      ),
    )
    // One control per public file the fixture names.
    expect(kept.map(([path]) => path).sort()).toEqual(withNames.sort())
    for (const [path, name, value] of kept) {
      expect([path, name, exportedNames(path, read(path)).includes(name)]).toEqual([
        path,
        name,
        true,
      ])
      const namespace = (await import(join(SRC, path))) as Record<string, unknown>
      expect([path, name, name in namespace]).toEqual([path, name, value])
    }
  })
})

describe('RFC-551 —— public 里的声明按内容落进模块内部（design §2）', () => {
  test('在新位置导出，不在本模块任一 public 文件里', () => {
    let moved = 0
    for (const [path, names] of Object.entries(MOVED)) {
      const context = /^modules\/([^/]+)\//.exec(path)![1] as Context
      expect(CONTEXTS).toContain(context)
      const exported = exportedNames(path, read(path))
      const publicExports = publicExportsOf(context)
      for (const name of names) {
        moved += 1
        expect([path, name, exported.includes(name)]).toEqual([path, name, true])
        expect([context, name, publicExports.includes(name)]).toEqual([context, name, false])
      }
    }
    // 31 withdrawn names: 14 declarations moved, 17 re-exports dropped.
    expect(moved).toBe(14)
  })

  test('source-control 的凭据选择结果落在 domain：domain 不取 application，选择端口从 domain 取它', () => {
    const domain = SC + 'domain/repositoryTransportCredential.ts'
    const specifiers = specifiersIn(read(domain))
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter((specifier) => /\/application(\/|$)/.test(specifier))).toEqual([])
    expect(
      specifiersIn(read(SC + 'application/ports/repositoryTransportCredentials.ts')),
    ).toContain('../../domain/repositoryTransportCredential')
  })

  test('identity-access 的用户操作合同仍声明在 public，只以 type-only 取 application 的输入 schema', () => {
    const path = IA + 'public/operations.ts'
    expect(exportedNames(path, read(path))).toContain('IdentityUserOperations')
    const fromApplication = importClauses(path, read(path)).filter(({ specifier }) =>
      specifier.startsWith('../application/'),
    )
    expect(fromApplication).toEqual([
      { specifier: '../application/userOperationDescriptors', typeOnly: true },
    ])
  })
})

describe('RFC-551 —— 报告的类型形状遍历纳入类的构造参数属性（回归）', () => {
  const MEMORY = 'packages/backend/src/modules/memory/'
  const unconsumed = (files: Record<string, string>) =>
    unconsumedPublicSymbols(
      corpusPublicContract(
        createGateCorpus(Object.entries(files).map(([path, text]) => sourceUnit(path, text))),
      ).publicSurfaces,
    )
      .map((entry) => entry.id)
      .sort()
  // `MemoryLookupError` 有模块外读者；四个 kind 只经它的构造参数引用，各用一种形式。
  const TYPES = [
    "export type MemoryErrorKind = 'missing' | 'stale'",
    "export type MemoryHiddenKind = 'hidden'",
    "export type MemoryGuardedKind = 'guarded'",
    "export type MemoryPlainKind = 'plain'",
    'export class MemoryLookupError extends Error {',
    '  constructor(',
    '    readonly kind: MemoryErrorKind,',
    '    private readonly hidden: MemoryHiddenKind,',
    '    protected readonly guarded: MemoryGuardedKind,',
    '    plain: MemoryPlainKind,',
    '  ) {',
    '    super(String(plain))',
    '  }',
    '}',
    '',
  ].join('\n')
  const CONSUMER = 'packages/backend/src/modules/intent/application/memoryLookup.ts'
  const USE =
    "import { MemoryLookupError } from '@/modules/memory/public/types'\n" +
    'export const isLookupError = (value: unknown): boolean => value instanceof MemoryLookupError\n'

  test('只经 public 类的构造参数属性引用的类型算作被消费', () => {
    expect(unconsumed({ [MEMORY + 'public/types.ts']: TYPES, [CONSUMER]: USE })).toEqual([
      'public:memory:types:MemoryGuardedKind',
      'public:memory:types:MemoryHiddenKind',
      'public:memory:types:MemoryPlainKind',
    ])
  })

  test('负对照：private / protected 参数属性与普通构造参数仍计入；去掉读者后类本身也计入', () => {
    expect(unconsumed({ [MEMORY + 'public/types.ts']: TYPES })).toEqual([
      'public:memory:types:MemoryGuardedKind',
      'public:memory:types:MemoryHiddenKind',
      'public:memory:types:MemoryLookupError',
      'public:memory:types:MemoryPlainKind',
    ])
  })
})

describe('RFC-551 —— 减速带', () => {
  test('counts.json：两个 context 的未消费计数上限为 0，全部 context 都是 0', () => {
    const counts = (
      JSON.parse(readFileSync(join(REPO_ROOT, 'architecture', 'counts.json'), 'utf8')) as {
        counts: Record<string, { max: number; reason: string }>
      }
    ).counts
    for (const context of CONTEXTS)
      expect([context, counts[`unconsumed-public-symbols-${context}`]?.max]).toEqual([context, 0])
    const all = Object.entries(counts).filter(([id]) => id.startsWith('unconsumed-public-symbols-'))
    // RFC-590: one per context with a public surface; task-catalog has none any more.
    expect(all.length).toBeGreaterThanOrEqual(18)
    expect(all.filter(([, entry]) => entry.max !== 0).map(([id]) => id)).toEqual([])
  })
})
