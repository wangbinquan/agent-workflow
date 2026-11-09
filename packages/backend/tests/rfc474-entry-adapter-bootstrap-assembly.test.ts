// RFC-474 — 入口适配器经 bootstrap 装配：CLI 命令、路由挂载与首启示例不再直取模块内部（RFC-294 W9-D 第二十一步）。
//
// 锁五件事：
// ① `cli/doctor.ts`（RFC-370 留下的 Doctor 兼容转出）不在：backend 的 src / 用例 / 脚本零 import（`preProcessFile` 取全部模块引用，带负对照）；
//    四个包、e2e、仓根脚本与 `.github/workflows` 里没有指着它的路径（注释不算，带负对照）；`design/` 与 `docs/` 的 Markdown 相对链接也不指着它
//    （CI 的 lychee 逐条查仓内文件，RFC-472 实撞）。
// ② census 的 `R1`（非模块文件取模块内部）里没有五个入口文件的边；负对照：同一规则把 `cli/` 文件取 composition 的合成样例判为 `R1`。
// ③ 路由：knowledge-evolution `composition/routes` 恰好转出两个挂载、与 inbound 的是同一函数；`server.ts` 从它取。
// ④ 命令装配：`main.ts` 把 bootstrap 组装的依赖交给 config / migration-report，doctor 分支取 bootstrap 的 `runDoctorCommand()`；三个 CLI
//    文件不取任何 `@/modules/`；Doctor composition 交出的 `formatDoctor` 与 domain 的是同一函数；development-automation 的 `render` 就是
//    `printMigrationReport`。
// ⑤ 首启示例：`services/demoSeed.ts` 不取任何 composition；code-capability `public/types` 恰好转出两个类型（RFC-453 退役的
//    `public/participants.ts` 不复活）；`daemonApplication` 的
//    `demo-seed` 启动步骤体内组装完成标记并作为 `completion` 传入（每次启动调用时选，不在模块加载时选）。
// 另：`windows-platform.yml` 路径过滤里的每个具体文件都在。
// 行为由既有用例覆盖（都改为走注入）：`cli`、`rfc370-cli-configuration-bindings`、doctor 族、`rfc395-af1-cli-selection`、`rfc307-demo-seed`、
// `rfc370-installation-seed-completion`、`rfc395-demo-template-only`、`rfc349-fusion-route-provider`。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, inboundBoundaryEdges, sourceUnit } from './architecture/census'
import { BACKEND_PREFIX } from './architecture/rfc294Gates'
import { bootImplementation } from './helpers/daemonProgramSource'
import * as keRoutes from '@/modules/knowledge-evolution/composition/routes'
import { mountFusionRoutes } from '@/modules/knowledge-evolution/inbound/fusionRoutes'
import { mountSkillProvenanceRoutes } from '@/modules/knowledge-evolution/inbound/skillProvenanceRoutes'
import { formatDoctor as compositionFormatDoctor } from '@/modules/system-operations/composition/doctorDiagnostics'
import { formatDoctor } from '@/modules/system-operations/domain/doctorDiagnostics'
import { composeLegacyAssetMigrationReport } from '@/modules/development-automation/composition/migrationReport'
import { printMigrationReport } from '@/modules/development-automation/application/migrationAnalyzer'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RETIRED = 'cli/doctor'
const ENTRIES = [
  'server.ts',
  'cli/config-cli.ts',
  'cli/doctor.ts',
  'cli/migrationReport.ts',
  'services/demoSeed.ts',
] as const
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
/** Source text with whitespace and trailing commas removed, so the locks below do not depend on line wrapping. */
const compact = (text: string) => text.replace(/\s+/g, '').replace(/,\)/g, ')').replace(/,\}/g, '}')

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

const importsOf = (files: readonly string[]) =>
  files.flatMap((path) =>
    specifiersIn(readFileSync(path, 'utf8'))
      .filter((specifier) => targetOf(path, specifier) === RETIRED)
      .map((specifier) => `${slash(relative(REPO_ROOT, path))} -> ${specifier}`),
  )

const RETIRED_PATH = /(?:^|[/'"@])cli\/doctor(?:\.ts)?$/

/** String literals (not comments) that name the retired file by path — the shape `readFileSync(<path>)` locks use. */
function retiredPathLiterals(path: string, text: string): string[] {
  if (!text.includes('cli/doctor')) return []
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

/** Markdown relative links (`](…)`, anchors dropped) that resolve to the retired file. */
function retiredMarkdownLinks(path: string, text: string): string[] {
  if (!text.includes('cli/doctor')) return []
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1]!)
    .filter((link) => !/^[a-z]+:/i.test(link))
    .filter(
      (link) =>
        slash(relative(REPO_ROOT, resolve(path, '..', link.split('#')[0]!))) ===
        `packages/backend/src/${RETIRED}.ts`,
    )
    .map((link) => `${slash(relative(REPO_ROOT, path))} -> ${link}`)
}

/** The module specifier the import that binds `name` comes from (or null). */
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

/** Names a file re-exports (`export { … } from` / `export type { … } from`), sorted. */
function reExportedNames(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return source.statements
    .flatMap((statement) =>
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map((element) => element.name.text)
        : [],
    )
    .sort()
}

/** The text of one `case '<label>':` clause of the command switch in `main.ts`, whitespace removed. */
function mainCase(label: string): string {
  const source = ts.createSourceFile('main.ts', read('main.ts'), ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCaseClause(node) &&
      ts.isStringLiteral(node.expression) &&
      node.expression.text === label
    )
      found.push(compact(node.getText(source)))
    node.forEachChild(visit)
  }
  visit(source)
  expect([label, found.length]).toEqual([label, 1])
  return found[0]!
}

describe('RFC-474 —— `cli/doctor.ts` 不在、零引用', () => {
  test('文件不在', () => {
    expect(existsSync(join(SRC, `${RETIRED}.ts`))).toBe(false)
  })

  test('backend 的 src、用例与脚本零 import 它', () => {
    expect(importsOf(walk(SRC))).toEqual([])
    expect(importsOf(walk(TESTS))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'scripts')))).toEqual([])
  }, 60_000)

  test('四个包、e2e、仓根脚本与 workflow 里没有指着它的路径（注释不算）', () => {
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
      readFileSync(path, 'utf8').includes('packages/backend/src/cli/doctor.ts'),
    )
    expect(workflows.map((path) => slash(relative(REPO_ROOT, path)))).toEqual([])
  }, 120_000)

  test('design/ 与 docs/ 的 Markdown 相对链接不指着它', () => {
    const markdown = [join(REPO_ROOT, 'design'), join(REPO_ROOT, 'docs')].flatMap((root) =>
      walk(root, /\.md$/),
    )
    // Positive control: the corpus is the whole design tree.
    expect(markdown.length).toBeGreaterThan(500)
    expect(
      markdown.flatMap((path) => retiredMarkdownLinks(path, readFileSync(path, 'utf8'))),
    ).toEqual([])
    // Negative control: a relative link to the retired file is found; a sibling and a code span are not.
    expect(
      retiredMarkdownLinks(
        join(REPO_ROOT, 'design', 'RFC-000-probe', 'evidence.md'),
        [
          '[doctor](../../packages/backend/src/cli/doctor.ts#L28)',
          '[database](../../packages/backend/src/cli/database.ts)',
          '`packages/backend/src/cli/doctor.ts`',
        ].join('\n'),
      ),
    ).toEqual(['design/RFC-000-probe/evidence.md -> ../../packages/backend/src/cli/doctor.ts#L28'])
  })

  test('负对照：判据认得出别名、相对路径、空 import {}、类型转出与动态 import，也认得出路径字面量；不误伤注释与同前缀', () => {
    expect(targetOf(join(SRC, 'cli', 'probe.ts'), './doctor')).toBe(RETIRED)
    expect(targetOf(join(TESTS, 'probe.test.ts'), '../src/cli/doctor')).toBe(RETIRED)
    const fixture = [
      "import {} from '@/cli/doctor'",
      "export type { X } from '../cli/doctor'",
      "const lazy = import('@/cli/doctor')",
      '// @/cli/doctor (a comment)',
      "import { y } from '@/cli/doctorSummary'",
      "import { z } from '@/bootstrap/doctorDiagnostics'",
    ].join('\n')
    expect(
      specifiersIn(fixture).filter(
        (specifier) => targetOf(join(SRC, 'routes', 'probe.ts'), specifier) === RETIRED,
      ),
    ).toHaveLength(3)
    expect(
      retiredPathLiterals(
        // An absolute probe path: `relative(REPO_ROOT, …)` of a bare name would resolve against the process cwd.
        join(REPO_ROOT, 'probe.ts'),
        [
          "read('packages/backend/src/cli/doctor.ts')",
          "spec('@/cli/doctor')",
          "read('src/cli/doctors.ts')",
          "read('src/bootstrap/doctorDiagnostics.ts')",
          '// packages/backend/src/cli/doctor.ts',
        ].join('\n'),
      ),
    ).toEqual(['probe.ts: packages/backend/src/cli/doctor.ts', 'probe.ts: @/cli/doctor'])
  })
})

describe('RFC-474 —— 五个入口不再取模块内部', () => {
  test('census 的 R1 里没有五个入口文件的边', () => {
    const offending = inboundBoundaryEdges(backendUnits(REPO_ROOT))
      .filter((edge) =>
        (ENTRIES as readonly string[]).includes(edge.from.slice(BACKEND_PREFIX.length)),
      )
      .map((edge) => `${edge.from} -> ${edge.to} (${edge.edgeKind})`)
    expect(offending).toEqual([])
  }, 120_000)

  test('负对照：同一规则把 cli/ 文件取 composition 或 domain 判为 R1，取 public 不判', () => {
    const probe = (text: string) =>
      inboundBoundaryEdges([sourceUnit(BACKEND_PREFIX + 'cli/probe.ts', text)]).map(
        (edge) => edge.to,
      )
    expect(
      probe(
        [
          "import { composeFileCliConfiguration } from '@/modules/system-operations/composition/cliConfiguration'",
          "import { formatDoctor } from '@/modules/system-operations/domain/doctorDiagnostics'",
          "import type { BackupResultView } from '@/modules/system-operations/public/types'",
        ].join('\n'),
      ),
    ).toEqual([
      'modules/system-operations/composition/cliConfiguration',
      'modules/system-operations/domain/doctorDiagnostics',
    ])
  })

  test('三个 CLI 文件与首启示例编排不取任何 @/modules/ 内部（示例编排只取 public）', () => {
    for (const path of ['cli/config-cli.ts', 'cli/migrationReport.ts'])
      expect([path, specifiersIn(read(path)).filter((s) => s.startsWith('@/modules/'))]).toEqual([
        path,
        [],
      ])
    const seed = specifiersIn(read('services/demoSeed.ts')).filter((s) =>
      s.startsWith('@/modules/'),
    )
    expect(seed.filter((s) => !/^@\/modules\/[a-z-]+\/public\/[a-z]+$/.test(s))).toEqual([])
    // Positive control: the seed still takes the two participant types and the completion port through public.
    expect(seed.sort()).toEqual([
      '@/modules/code-capability/public/types',
      '@/modules/resource-catalog/public/participants',
      '@/modules/system-operations/public/participants',
    ])
  })
})

describe('RFC-474 —— 路由挂载经 knowledge-evolution composition', () => {
  test('composition/routes 恰好转出两个挂载，与 inbound 的是同一函数', () => {
    const path = 'modules/knowledge-evolution/composition/routes.ts'
    expect(reExportedNames(path, read(path))).toEqual([
      'mountFusionRoutes',
      'mountSkillProvenanceRoutes',
    ])
    expect(keRoutes.mountFusionRoutes).toBe(mountFusionRoutes)
    expect(keRoutes.mountSkillProvenanceRoutes).toBe(mountSkillProvenanceRoutes)
  })

  test('server.ts 从 composition/routes 取两个挂载', () => {
    for (const name of ['mountFusionRoutes', 'mountSkillProvenanceRoutes'])
      expect([name, sourceOfName('server.ts', read('server.ts'), name)]).toEqual([
        name,
        '@/modules/knowledge-evolution/composition/routes',
      ])
  })
})

describe('RFC-474 —— 命令依赖由 bootstrap 组装、main.ts 注入', () => {
  test('main.ts 的三个分支取 bootstrap 组装的依赖', () => {
    const config = mainCase('config')
    expect(config).toContain('awaitconfigGetCommand(rest,composeConfigCommandPersistence())')
    expect(config).toContain('awaitconfigSetCommand(rest,composeConfigCommandPersistence())')
    expect(mainCase('doctor')).toContain('const{ok,output}=awaitrunDoctorCommand()')
    expect(mainCase('migration-report')).toContain(
      'migrationReportCommand(Bun.argv.slice(3),composeMigrationReportCommandDependencies())',
    )
    for (const name of [
      'composeConfigCommandPersistence',
      'composeMigrationReportCommandDependencies',
      'runDoctorCommand',
    ])
      expect([name, sourceOfName('main.ts', read('main.ts'), name)]).toEqual([
        name,
        './bootstrap/commandBootstraps',
      ])
  })

  test('bootstrap 的三个入口组装的是 owner composition 交出的实现', () => {
    const bootstraps = read('bootstrap/commandBootstraps.ts')
    expect(sourceOfName('bootstrap/commandBootstraps.ts', bootstraps, 'formatDoctor')).toBe(
      '@/modules/system-operations/composition/doctorDiagnostics',
    )
    expect(
      sourceOfName('bootstrap/commandBootstraps.ts', bootstraps, 'composeFileCliConfiguration'),
    ).toBe('@/modules/system-operations/composition/cliConfiguration')
    expect(
      sourceOfName(
        'bootstrap/commandBootstraps.ts',
        bootstraps,
        'composeLegacyAssetMigrationReport',
      ),
    ).toBe('@/modules/development-automation/composition/migrationReport')
    const text = compact(bootstraps)
    expect(text).toContain('return{ok:result.ok,output:formatDoctor(result)}')
    expect(text).toContain('returncomposeFileCliConfiguration(Paths.config)')
    expect(text).toContain(
      'Object.freeze({contract:logicalSchemaContract,analysis:composeLegacyAssetMigrationReport})',
    )
  })

  test('Doctor composition 交出的 formatDoctor 与 domain 的是同一函数；migration report 的 render 就是 printMigrationReport', () => {
    expect(compositionFormatDoctor).toBe(formatDoctor)
    // The composition only binds the client; render is the analyzer's own renderer.
    expect(composeLegacyAssetMigrationReport({} as PersistenceDb).render).toBe(printMigrationReport)
  })

  test('migration report 在 legacy 行读完之后才取时间（与原 CLI 的求值顺序相同）', () => {
    expect(
      compact(read('modules/development-automation/composition/migrationReport.ts')),
    ).toContain('analyzeLegacyAssets(awaitcollectLegacyAssets(db),now())')
    expect(compact(read('cli/migrationReport.ts'))).toContain('analysis.analyze(()=>Date.now())')
  })
})

describe('RFC-474 —— 首启示例：参与方类型经 public、完成标记由 bootstrap 启动步骤组装', () => {
  test('code-capability public/types 恰好转出两个类型；RFC-453 退役的 public/participants.ts 不复活', () => {
    const path = 'modules/code-capability/public/types.ts'
    expect(reExportedNames(path, read(path))).toEqual([
      'CodeCapabilityDemoSeedParticipant',
      'CodeCapabilityDemoSeedReceipt',
    ])
    // RFC-453 moved the code-review artifact participant that file held to workspace-insight and locks the path absent.
    expect(existsSync(join(SRC, 'modules/code-capability/public/participants.ts'))).toBe(false)
  })

  test('demo-seed 启动步骤体内组装完成标记并传入', () => {
    const step = compact(bootImplementation(read('bootstrap/daemonApplication.ts'), 'demo-seed'))
    expect(step).toContain('completion:composeInstallationSeedCompletion()})')
    expect(
      sourceOfName(
        'bootstrap/daemonApplication.ts',
        read('bootstrap/daemonApplication.ts'),
        'composeInstallationSeedCompletion',
      ),
    ).toBe('@/modules/system-operations/composition/installationSeedCompletion')
    // The seed itself no longer selects a default: the completion is required.
    expect(compact(read('services/demoSeed.ts'))).toContain(
      'readonlycompletion:InstallationSeedCompletionPort',
    )
  })
})

describe('RFC-474 —— workflow 路径过滤不失明', () => {
  test('windows-platform.yml 路径过滤里的每个具体文件都在', () => {
    const text = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'windows-platform.yml'),
      'utf8',
    )
    const concrete = [...text.matchAll(/^\s+- '(packages\/[^'*]+\.[a-z]+)'$/gm)].map((m) => m[1]!)
    // Positive control: the filters name the doctor family and its new command assembly.
    expect(concrete).toContain('packages/backend/src/bootstrap/commandBootstraps.ts')
    expect(concrete.filter((path) => !existsSync(join(REPO_ROOT, path)))).toEqual([])
  })
})
