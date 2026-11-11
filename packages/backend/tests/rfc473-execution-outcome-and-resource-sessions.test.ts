// RFC-473 — 执行结果投影与资源会话归 task-execution：`services/execution/{outcome,types,taskExecutionResources}.ts` 迁入（RFC-294 W9-D 第二十步）。
//
// 锁五件事：
// ① 三个旧文件不在：backend 的 src / 用例 / 脚本零 import（TypeScript `preProcessFile` 取全部模块引用，带负对照）；四个包、e2e、仓根脚本与
//    `.github/workflows` 里也没有指着它们的路径（RFC-470 实撞：别的包与 workflow 会按路径读后端源码；注释不算，带负对照）；
//    `design/` 与 `docs/` 的 Markdown 相对链接也不指着它们（CI 的 lychee 逐条查仓内文件，RFC-472 实撞，带负对照）。
// ② 新位置的形状：投影文件的导出名（含随迁的 `ExecutionOutcome`）；资源会话文件的导出名，且它不再转出任何东西（那 3 条 `R1` 就是转出）。
// ③ 依赖方向：两个新文件不取本模块 public 的值（模块内取定义处，AST 判定带正负对照）；三处投影调用方、七处资源会话调用方取新位置；
//    `server.ts` 与 `services/task.ts` 的两个类型取自 `public/commands`。
// ④ public 收回：`public/queries` 不再转出 `workgroupLaunchMode`（生产上只有投影取它）。
// ⑤ 清单不失明：`commons-manifest.json` 的每个内核文件都在（`rfc317-identity-dispatch` 读不到文件时静默跳过），投影内核指向新位置；
//    `windows-platform.yml` 路径过滤里的每个具体文件都在。
// 行为由既有用例覆盖（都改取新位置）：`rfc243-execution-outcome`（四种执行的投影，`getExecutionOutcome` 两引擎都跑）、资源绑定类用例等。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const TE = 'modules/task-execution/'
const RETIRED = [
  'services/execution/outcome',
  'services/execution/types',
  'services/execution/taskExecutionResources',
] as const
const OUTCOME = `${TE}infrastructure/executionOutcome.ts`
const RESOURCES = `${TE}infrastructure/taskExecutionResources.ts`
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

function walk(dir: string, pattern = /\.[cm]?tsx?$/): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path, pattern) : pattern.test(name) ? [path] : []
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

const isRetired = (target: string | null) =>
  target !== null && (RETIRED as readonly string[]).includes(target)

const importsOf = (files: readonly string[]) =>
  files.flatMap((path) =>
    specifiersIn(readFileSync(path, 'utf8'))
      .filter((specifier) => isRetired(targetOf(path, specifier)))
      .map((specifier) => `${slash(relative(REPO_ROOT, path))} -> ${specifier}`),
  )

const RETIRED_PATH =
  /(?:^|[/'"@])services\/execution\/(?:outcome|types|taskExecutionResources)(?:\.ts)?$/

/** String literals (not comments) that name a retired file by path — the shape `readFileSync(<path>)` locks use. */
function retiredPathLiterals(path: string, text: string): string[] {
  if (!text.includes('services/execution/')) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      RETIRED_PATH.test(node.text)
    )
      hits.push(`${slash(relative(REPO_ROOT, path))}: ${node.text}`)
    node.forEachChild(visit)
  }
  visit(source)
  return hits
}

/** Markdown relative links (`](…)`, anchors dropped) that resolve to a retired file. */
function retiredMarkdownLinks(path: string, text: string): string[] {
  if (!text.includes('services/execution/')) return []
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1]!)
    .filter((link) => !/^[a-z]+:/i.test(link))
    .filter((link) => {
      const target = slash(relative(REPO_ROOT, resolve(path, '..', link.split('#')[0]!)))
      return RETIRED.some((stem) => target === `packages/backend/src/${stem}.ts`)
    })
    .map((link) => `${slash(relative(REPO_ROOT, path))} -> ${link}`)
}

/** Value imports (not type-only) a module file takes from task-execution's own public entries. */
function ownPublicValueImports(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const specifier = statement.moduleSpecifier.text
    const target = targetOf(path, specifier)
    if (target === null || !target.startsWith(`${TE}public/`)) continue
    const clause = statement.importClause
    const named = clause?.namedBindings
    const typeOnly =
      clause !== undefined &&
      (clause.isTypeOnly ||
        (clause.name === undefined &&
          named !== undefined &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((element) => element.isTypeOnly)))
    if (!typeOnly) found.push(specifier)
  }
  return found
}

/** Names a file exports by declaration (not re-exports), plus whether it re-exports anything. */
function exportShape(path: string, text: string) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  let reExports = 0
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      reExports += 1
      continue
    }
    const exported =
      ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    if (!exported) continue
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name !== undefined
    )
      names.push(statement.name.text)
  }
  return { names: names.sort(), reExports }
}

/** The single import declaration that brings `name` into `text`, as its module specifier (or null). */
function sourceOfName(path: string, text: string, name: string): string | null {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const named = statement.importClause?.namedBindings
    if (named !== undefined && ts.isNamedImports(named))
      if (named.elements.some((element) => element.name.text === name))
        return statement.moduleSpecifier.text
  }
  return null
}

describe('RFC-473 —— 三个旧文件不在、零引用', () => {
  test('旧文件不在，新文件在', () => {
    for (const stem of RETIRED)
      expect([stem, existsSync(join(SRC, `${stem}.ts`))]).toEqual([stem, false])
    for (const path of [OUTCOME, RESOURCES])
      expect([path, existsSync(join(SRC, path))]).toEqual([path, true])
  })

  test('backend 的 src、用例与脚本零 import 它们', () => {
    expect(importsOf(walk(SRC))).toEqual([])
    expect(importsOf(walk(TESTS))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'scripts')))).toEqual([])
  }, 60_000)

  test('四个包、e2e、仓根脚本与 workflow 里没有指着它们的路径（注释不算）', () => {
    const roots = [
      ...['backend', 'shared', 'frontend', 'system-mocks'].flatMap((pkg) =>
        ['src', 'tests', 'scripts'].map((dir) => join(REPO_ROOT, 'packages', pkg, dir)),
      ),
      join(REPO_ROOT, 'e2e'),
      join(REPO_ROOT, 'scripts'),
    ]
    const hits = roots
      .flatMap((root) => walk(root))
      .filter((path) => path !== import.meta.path)
      .flatMap((path) => retiredPathLiterals(path, readFileSync(path, 'utf8')))
    expect(hits).toEqual([])
    const workflows = walk(join(REPO_ROOT, '.github', 'workflows'), /\.ya?ml$/).filter((path) =>
      /packages\/backend\/src\/services\/execution\/(?:outcome|types|taskExecutionResources)\.ts/.test(
        readFileSync(path, 'utf8'),
      ),
    )
    expect(workflows.map((path) => slash(relative(REPO_ROOT, path)))).toEqual([])
  }, 120_000)

  test('design/ 与 docs/ 的 Markdown 相对链接不指着它们（CI 的 lychee 逐条查仓内文件，RFC-472 实撞）', () => {
    const markdown = [join(REPO_ROOT, 'design'), join(REPO_ROOT, 'docs')].flatMap((root) =>
      walk(root, /\.md$/),
    )
    // Positive control: the corpus is the whole design tree.
    expect(markdown.length).toBeGreaterThan(500)
    expect(
      markdown.flatMap((path) => retiredMarkdownLinks(path, readFileSync(path, 'utf8'))),
    ).toEqual([])
    // Negative control: a relative link to a retired file is found, a sibling and a code span are not.
    expect(
      retiredMarkdownLinks(
        join(REPO_ROOT, 'design', 'RFC-000-probe', 'evidence.md'),
        [
          '[outcome](../../packages/backend/src/services/execution/outcome.ts#L12)',
          '[preflight](../../packages/backend/src/services/execution/triggerPreflight.ts)',
          '`packages/backend/src/services/execution/types.ts`',
        ].join('\n'),
      ),
    ).toEqual([
      'design/RFC-000-probe/evidence.md -> ../../packages/backend/src/services/execution/outcome.ts#L12',
    ])
  })

  test('负对照：判据认得出别名、相对路径、空 import {}、类型转出与动态 import，也认得出路径字面量；不误伤注释与同前缀', () => {
    expect(targetOf(join(SRC, 'services', 'execution', 'probe.ts'), './outcome')).toBe(
      'services/execution/outcome',
    )
    const fixture = [
      "import {} from '@/services/execution/outcome'",
      "export type { X } from '../services/execution/types'",
      "const lazy = import('@/services/execution/taskExecutionResources')",
      '// @/services/execution/outcome (a comment)',
      "import { y } from '@/services/execution/outcomeStore'",
      "import { z } from '@/services/execution/triggerPreflight'",
    ].join('\n')
    const targets = specifiersIn(fixture).map((specifier) =>
      targetOf(join(SRC, 'routes', 'probe.ts'), specifier),
    )
    expect(targets.filter(isRetired)).toHaveLength(3)
    expect(
      retiredPathLiterals(
        // An absolute probe path: `relative(REPO_ROOT, …)` of a bare name would resolve against the process cwd.
        join(REPO_ROOT, 'probe.ts'),
        [
          "read('packages/backend/src/services/execution/outcome.ts')",
          "spec('@/services/execution/types')",
          "src('services/execution/taskExecutionResources.ts')",
          "read('src/services/execution/outcomes.ts')",
          "spec('@/services/execution/typesafe')",
          '// packages/backend/src/services/execution/outcome.ts',
        ].join('\n'),
      ),
    ).toEqual([
      'probe.ts: packages/backend/src/services/execution/outcome.ts',
      'probe.ts: @/services/execution/types',
      'probe.ts: services/execution/taskExecutionResources.ts',
    ])
  })
})

describe('RFC-473 —— 新位置的形状', () => {
  test('投影文件：原有导出加随迁的 ExecutionOutcome，不转出别处', () => {
    expect(exportShape(OUTCOME, read(OUTCOME))).toEqual({
      names: [
        'ExecutionOutcome',
        'OutcomeOutputRow',
        'OutcomeRunRow',
        'OutcomeTaskRow',
        'WorkgroupOutcomeInput',
        'getExecutionOutcome',
        'projectExecutionOutcome',
      ],
      reExports: 0,
    })
  })

  test('资源会话文件：七个函数与六个类型，不再转出任何东西', () => {
    expect(exportShape(RESOURCES, read(RESOURCES))).toEqual({
      names: [
        'TaskAgentInjectionResolution',
        'TaskAgentResolvedInjectionSpec',
        'TaskAgentResourceSession',
        'TaskExecutionInjectionResolution',
        'TaskExecutionResolvedInjectionSpec',
        'TaskExecutionResourceSession',
        'createTaskAgentResourceSession',
        'createTaskExecutionResourceSession',
        'loadTaskExecutionResourceSnapshot',
        'resolveSyntheticTaskAgentInjection',
        'resolveSyntheticTaskExecutionInjection',
        'resolveTaskAgentInjection',
        'resolveTaskExecutionInjection',
      ],
      reExports: 0,
    })
  })
})

describe('RFC-473 —— 依赖方向', () => {
  test('两个新文件不取本模块 public 的值；调用方取新位置', () => {
    for (const path of [OUTCOME, RESOURCES])
      expect([path, ownPublicValueImports(join(SRC, path), read(path))]).toEqual([path, []])
    // Positive control: the projection still takes its read-model type from where it is defined (public/types), type-only.
    expect(sourceOfName(OUTCOME, read(OUTCOME), 'TaskExecutionOutcomeReadModel')).toBe(
      '../public/types',
    )
    for (const [file, name, from] of [
      [
        'composition/actionExecutionEnvironment.ts',
        'getExecutionOutcome',
        '../infrastructure/executionOutcome',
      ],
      [
        'composition/childCallNodeExecution.ts',
        'getExecutionOutcome',
        '../infrastructure/executionOutcome',
      ],
      [
        'composition/digitalEmployeeExecution.ts',
        'projectExecutionOutcome',
        '../infrastructure/executionOutcome',
      ],
      [
        'composition/taskEngineApplication.ts',
        'createTaskAgentResourceSession',
        '../infrastructure/taskExecutionResources',
      ],
      [
        'composition/taskMechanicsState.ts',
        'TaskAgentResourceSession',
        '../infrastructure/taskExecutionResources',
      ],
      [
        'composition/agentNodeExecution.ts',
        'resolveSyntheticTaskAgentInjection',
        '../infrastructure/taskExecutionResources',
      ],
      [
        'composition/commitPushBinding.ts',
        'resolveSyntheticTaskAgentInjection',
        '../infrastructure/taskExecutionResources',
      ],
      [
        'composition/mergeConflictResolution.ts',
        'resolveSyntheticTaskAgentInjection',
        '../infrastructure/taskExecutionResources',
      ],
      [
        'composition/taskEngineRuntimeOptions.ts',
        'TaskExecutionResourceBinding',
        '../application/ports/taskExecutionResourceSnapshots',
      ],
      [
        'infrastructure/taskExecutionRuntimeParticipants.ts',
        'TaskExecutionResourceBinding',
        '../application/ports/taskExecutionResourceSnapshots',
      ],
      // RFC-478: the sync preview (services/task.ts's last use of the authority type) moved inside the module.
      [
        'application/workflowSyncPreviewQuery.ts',
        'TaskExecutionResourceAuthority',
        './ports/taskExecutionResourceSnapshots',
      ],
    ] as const)
      expect([file, sourceOfName(TE + file, read(TE + file), name)]).toEqual([file, from])
    expect(sourceOfName('server.ts', read('server.ts'), 'TaskExecutionResourceBinding')).toBe(
      '@/modules/task-execution/public/commands',
    )
  })

  test('负对照：本模块 public 的值导入与混合导入认得出，纯类型导入不算', () => {
    const probe = join(SRC, TE, 'infrastructure', 'probe.ts')
    expect(
      ownPublicValueImports(
        probe,
        [
          "import { a } from '../public/queries'",
          "import { type B, c } from '@/modules/task-execution/public/types'",
          "import type { D } from '../public/types'",
          "import { type E } from '../public/commands'",
          "import { f } from '../domain/taskSubject'",
          "import { g } from '@/modules/collaboration/public/queries'",
        ].join('\n'),
      ),
    ).toEqual(['../public/queries', '@/modules/task-execution/public/types'])
  })

  test('public 收回：public/queries 不再转出 workgroupLaunchMode', () => {
    const queries = read(`${TE}public/queries.ts`)
    expect(queries).not.toMatch(/\bworkgroupLaunchMode\b/)
    // 正对照：读到的是真文件。RFC-480 把同处的 `decodeTaskWorkgroupConfig` 转出也撤了（模块外零消费），
    // 改取仍留在 public 的一项。
    expect(queries).toContain(
      "export { hasTaskRollbackCheckpoint } from '../domain/taskCheckpointRollback'",
    )
  })
})

describe('RFC-473 —— 清单不失明', () => {
  test('公共内核清单里的每个文件都在，投影内核指向新位置', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'architecture', 'commons-manifest.json'), 'utf8'),
    ) as {
      readonly kernels: ReadonlyArray<{ readonly id: string; readonly files?: readonly string[] }>
    }
    const missing = manifest.kernels.flatMap((kernel) =>
      (kernel.files ?? [])
        .filter((file) => !existsSync(join(REPO_ROOT, file)))
        .map((file) => `${kernel.id}: ${file}`),
    )
    expect(missing).toEqual([])
    expect(
      manifest.kernels.find((kernel) => kernel.id === 'projectexecutionoutcome')?.files,
    ).toEqual([`packages/backend/src/${OUTCOME}`])
  })

  test('windows-platform 的路径过滤里每个具体文件都在，资源会话新路径两份过滤都登记', () => {
    const workflow = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'windows-platform.yml'),
      'utf8',
    )
    const listed = [...workflow.matchAll(/^\s*- '([^']+)'\s*$/gm)].map((match) => match[1]!)
    const concrete = listed.filter((path) => !/[*?[!]/.test(path))
    // Positive control: the filters are long lists of concrete backend files.
    expect(concrete.length).toBeGreaterThan(100)
    expect(concrete.filter((path) => !existsSync(join(REPO_ROOT, path)))).toEqual([])
    expect(listed.filter((path) => path === `packages/backend/src/${RESOURCES}`)).toHaveLength(2)
  })
})
