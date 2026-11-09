// RFC-475 — 自动提交推送按 owner 拆开：git 发布归 source-control、提交行记账归 task-execution（RFC-294 W9-D 第二十二步）。
//
// 锁五件事：
// ① `services/commitPushRunner.ts` 与 `services/commitPush.ts` 不在：backend 的 src / 用例 / 脚本零 import（`preProcessFile` 取全部模块引用，
//    带负对照）；各包、e2e、仓根脚本与 `.github/workflows` 里没有指着它们的路径字面量（注释不算，带负对照）；`design/` 与 `docs/` 的 Markdown
//    相对链接也不指着它们（带负对照）。
// ② census 的 `R1` 里没有它们；负对照：同一规则把 `services/` 文件取 task-execution application 端口的合成样例判为 `R1`。
// ③ 方向：source-control 的发布用例、binder、合同与 domain 不取 task-execution；task-execution 的提交记账只经 source-control `public/` 取发布
//    （带负对照）。
// ④ 合同：`public/participants` 转出 binder 与参与方类型、`public/types` 转出合同类型；public surface 偏差判据对新合同不报任何一条（带负对照）；
//    模块根 `composition.ts` 转出的提交 binder 与 `composition/repositoryCommit.ts` 的是同一函数，`classifyRepositoryPushFailure` 不再经
//    composition 转出。
// ⑤ 记账与转手：`commitPushBinding` 取 `infrastructure/commitPushAttempt` 与 `domain/commitAgent`；task-execution `public/queries` 不再转出
//    `repositoryPublicationOrdinal`；`util/git` 的两个子仓列表函数在样例上给出原来的结果。
// 行为由既有 commit-push 用例覆盖（都改走新位置）：`commit-push-runner`、RFC-210 子仓三个、`rfc370-repository-git-workspace`、
// `rfc098-commitpush-nonblocking`、`rfc205-git-credential`、`scheduler-commit-push`、`commit-push-core`、`commit-push-output-lang-directive`。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import {
  backendUnits,
  inboundBoundaryEdges,
  packageSrcUnits,
  sourceUnit,
} from './architecture/census'
import { BACKEND_PREFIX, publicSurfaceViolations } from './architecture/rfc294Gates'
import * as sourceControlComposition from '@/modules/source-control/composition'
import { bindRepositoryCommitParticipant } from '@/modules/source-control/composition/repositoryCommit'
import { bindWorkspaceChangePublication } from '@/modules/source-control/composition/workspaceChangePublication'
import * as sourceControlParticipants from '@/modules/source-control/public/participants'
import { bottomUp, usableSubmodules } from '@/util/git'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RETIRED = ['services/commitPushRunner', 'services/commitPush'] as const
const SC = 'modules/source-control/'
const TE = 'modules/task-execution/'
/** The source-control half: the publication use case, its contract, its binders and the moved pure judgements. */
const SOURCE_CONTROL_FILES = [
  SC + 'application/workspaceChangePublication.ts',
  SC + 'application/ports/workspaceChangePublication.ts',
  SC + 'composition/workspaceChangePublication.ts',
  SC + 'composition/repositoryCommit.ts',
  SC + 'domain/repositoryPushFailure.ts',
  SC + 'domain/stagedChangeSummary.ts',
] as const
const ATTEMPT = TE + 'infrastructure/commitPushAttempt.ts'
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

const isRetired = (stem: string | null) => (RETIRED as readonly string[]).includes(stem ?? '')

const importsOf = (files: readonly string[]) =>
  files.flatMap((path) =>
    specifiersIn(readFileSync(path, 'utf8'))
      .filter((specifier) => isRetired(targetOf(path, specifier)))
      .map((specifier) => `${slash(relative(REPO_ROOT, path))} -> ${specifier}`),
  )

const RETIRED_PATH = /(?:^|[/'"@])services\/commitPush(?:Runner)?(?:\.ts)?$/

/** String literals (not comments) that name a retired file by path — the shape `readFileSync(<path>)` locks use. */
function retiredPathLiterals(path: string, text: string): string[] {
  if (!text.includes('commitPush')) return []
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
  if (!text.includes('commitPush')) return []
  const targets = RETIRED.map((stem) => `packages/backend/src/${stem}.ts`)
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1]!)
    .filter((link) => !/^[a-z]+:/i.test(link))
    .filter((link) =>
      targets.includes(slash(relative(REPO_ROOT, resolve(path, '..', link.split('#')[0]!)))),
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

/** Names a file re-exports (`export { … } from` / `export type { … } from`) from `from`, sorted. */
function reExportedNamesFrom(path: string, text: string, from: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return source.statements
    .flatMap((statement) =>
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === from &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map((element) => element.name.text)
        : [],
    )
    .sort()
}

/** Module specifiers of a file that leave the module through anything but another context's exact `public/` entry. */
function crossContextInternals(path: string, text: string, ownContext: string): string[] {
  return specifiersIn(text).filter((specifier) => {
    const match = /^@\/modules\/([a-z-]+)\/(.+)$/.exec(specifier)
    if (match === null || match[1] === ownContext) return false
    return !/^public\/(?:commands|queries|participants|events|operations|types)$/.test(match[2]!)
  })
}

describe('RFC-475 —— 两个 services/ 文件不在、零引用', () => {
  test('文件不在', () => {
    for (const stem of RETIRED)
      expect([stem, existsSync(join(SRC, `${stem}.ts`))]).toEqual([stem, false])
  })

  test('backend 的 src、用例与脚本零 import 它们', () => {
    expect(importsOf(walk(SRC))).toEqual([])
    expect(importsOf(walk(TESTS))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'scripts')))).toEqual([])
  }, 60_000)

  test('各包、e2e、仓根脚本与 workflow 里没有指着它们的路径（注释不算）', () => {
    const roots = [
      ...['backend', 'shared', 'frontend', 'system-mocks'].flatMap((pkg) =>
        ['src', 'tests', 'scripts'].map((dir) => join(REPO_ROOT, 'packages', pkg, dir)),
      ),
      join(REPO_ROOT, 'e2e'),
      join(REPO_ROOT, 'scripts'),
    ]
    const hits = roots
      .flatMap((root) => walk(root))
      // The two locks that name the retired paths on purpose: this file and the RFC-412 deletion list.
      .filter(
        (path) =>
          path !== import.meta.path &&
          slash(relative(REPO_ROOT, path)) !==
            'packages/backend/tests/architecture/rfc412-scheduler-residue.test.ts',
      )
      .flatMap((path) => retiredPathLiterals(path, readFileSync(path, 'utf8')))
    expect(hits).toEqual([])
    const workflows = walk(join(REPO_ROOT, '.github', 'workflows'), /\.ya?ml$/).filter((path) =>
      /packages\/backend\/src\/services\/commitPush(?:Runner)?\.ts/.test(
        readFileSync(path, 'utf8'),
      ),
    )
    expect(workflows.map((path) => slash(relative(REPO_ROOT, path)))).toEqual([])
  }, 120_000)

  test('design/ 与 docs/ 的 Markdown 相对链接不指着它们', () => {
    const markdown = [join(REPO_ROOT, 'design'), join(REPO_ROOT, 'docs')].flatMap((root) =>
      walk(root, /\.md$/),
    )
    // Positive control: the corpus is the whole design tree.
    expect(markdown.length).toBeGreaterThan(500)
    expect(
      markdown.flatMap((path) => retiredMarkdownLinks(path, readFileSync(path, 'utf8'))),
    ).toEqual([])
    // Negative control: relative links to either retired file are found; a sibling and a code span are not.
    expect(
      retiredMarkdownLinks(
        join(REPO_ROOT, 'design', 'RFC-000-probe', 'evidence.md'),
        [
          '[runner](../../packages/backend/src/services/commitPushRunner.ts#L346)',
          '[core](../../packages/backend/src/services/commitPush.ts)',
          '[merge](../../packages/backend/src/services/mergeAgent.ts)',
          '`packages/backend/src/services/commitPushRunner.ts`',
        ].join('\n'),
      ),
    ).toEqual([
      'design/RFC-000-probe/evidence.md -> ../../packages/backend/src/services/commitPushRunner.ts#L346',
      'design/RFC-000-probe/evidence.md -> ../../packages/backend/src/services/commitPush.ts',
    ])
  })

  test('负对照：判据认得出别名、相对路径、空 import {}、类型转出与动态 import，也认得出路径字面量；不误伤注释与同前缀', () => {
    expect(targetOf(join(SRC, 'services', 'probe.ts'), './commitPush')).toBe('services/commitPush')
    expect(targetOf(join(TESTS, 'probe.test.ts'), '../src/services/commitPushRunner')).toBe(
      'services/commitPushRunner',
    )
    const fixture = [
      "import {} from '@/services/commitPushRunner'",
      "export type { X } from '../services/commitPush'",
      "const lazy = import('@/services/commitPush')",
      '// @/services/commitPush (a comment)',
      "import { y } from '@/services/commitPushSummary'",
      "import { z } from '@/modules/task-execution/domain/commitAgent'",
    ].join('\n')
    expect(
      specifiersIn(fixture).filter((specifier) =>
        isRetired(targetOf(join(SRC, 'routes', 'probe.ts'), specifier)),
      ),
    ).toHaveLength(3)
    expect(
      retiredPathLiterals(
        // An absolute probe path: `relative(REPO_ROOT, …)` of a bare name would resolve against the process cwd.
        join(REPO_ROOT, 'probe.ts'),
        [
          "read('packages/backend/src/services/commitPushRunner.ts')",
          "spec('@/services/commitPush')",
          "read('src/services/commitPushes.ts')",
          "read('src/modules/task-execution/infrastructure/commitPushAttempt.ts')",
          '// packages/backend/src/services/commitPush.ts',
        ].join('\n'),
      ),
    ).toEqual([
      'probe.ts: packages/backend/src/services/commitPushRunner.ts',
      'probe.ts: @/services/commitPush',
    ])
  })
})

describe('RFC-475 —— R1 销账与方向', () => {
  test('census 的 R1 里没有它们的边', () => {
    const offending = inboundBoundaryEdges(backendUnits(REPO_ROOT))
      .filter((edge) => RETIRED.some((stem) => edge.from === `${BACKEND_PREFIX}${stem}.ts`))
      .map((edge) => `${edge.from} -> ${edge.to} (${edge.edgeKind})`)
    expect(offending).toEqual([])
  }, 120_000)

  test('负对照：同一规则把 services/ 文件取 task-execution application 端口或 source-control composition 判为 R1，取 public 不判', () => {
    const probe = (text: string) =>
      inboundBoundaryEdges([sourceUnit(BACKEND_PREFIX + 'services/probe.ts', text)]).map(
        (edge) => edge.to,
      )
    expect(
      probe(
        [
          "import type { NodeExecutionPersistence } from '@/modules/task-execution/application/ports/nodeExecutionPersistence'",
          "import { bindRepositoryCommitParticipant } from '@/modules/source-control/composition'",
          "import { bindWorkspaceChangePublication } from '@/modules/source-control/public/participants'",
        ].join('\n'),
      ),
    ).toEqual([
      'modules/source-control/composition',
      'modules/task-execution/application/ports/nodeExecutionPersistence',
    ])
  })

  test('source-control 一半不取 task-execution，task-execution 记账只经 source-control public 取发布', () => {
    for (const path of SOURCE_CONTROL_FILES)
      expect([
        path,
        specifiersIn(read(path)).filter((specifier) =>
          specifier.startsWith('@/modules/task-execution'),
        ),
      ]).toEqual([path, []])
    expect(crossContextInternals(ATTEMPT, read(ATTEMPT), 'task-execution')).toEqual([])
    // Positive control: the attempt does publish through the source-control public participant.
    expect(sourceOfName(ATTEMPT, read(ATTEMPT), 'bindWorkspaceChangePublication')).toBe(
      '@/modules/source-control/public/participants',
    )
    // Negative control: a deep import of the use case or the binder is reported.
    expect(
      crossContextInternals(
        ATTEMPT,
        [
          "import { publishWorkspaceChanges } from '@/modules/source-control/application/workspaceChangePublication'",
          "import { bindRepositoryCommitParticipant } from '@/modules/source-control/composition'",
          "import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'",
        ].join('\n'),
        'task-execution',
      ),
    ).toEqual([
      '@/modules/source-control/application/workspaceChangePublication',
      '@/modules/source-control/composition',
    ])
  })
})

describe('RFC-475 —— source-control 的发布合同', () => {
  const CONTRACT = '../application/ports/workspaceChangePublication'

  test('public 入口转出 binder、参与方类型与合同类型', () => {
    expect(
      reExportedNamesFrom(
        SC + 'public/participants.ts',
        read(SC + 'public/participants.ts'),
        CONTRACT,
      ),
    ).toEqual(['WorkspaceChangePublicationParticipant'])
    expect(sourceControlParticipants.bindWorkspaceChangePublication).toBe(
      bindWorkspaceChangePublication,
    )
    // The sub-workspace binder's only outside consumer was the retired runner's submodule stage.
    expect('bindRepositoryGitSubworkspace' in sourceControlParticipants).toBe(false)
    expect(
      reExportedNamesFrom(SC + 'public/types.ts', read(SC + 'public/types.ts'), CONTRACT),
    ).toEqual([
      'RepositoryPublicationLogFields',
      'RepositoryPublicationLogger',
      'WorkspaceChangeMessage',
      'WorkspaceChangeMessageAuthor',
      'WorkspaceChangeMessageContext',
      'WorkspaceChangePublicationRequest',
      'WorkspaceChangePublicationResult',
      'WorkspaceChangeRepairContext',
      'WorkspaceWriteLease',
      'WorkspaceWriteLock',
    ])
  })

  test('public surface 偏差判据对新合同不报任何一条', () => {
    // The judgement records each declaration under the first public root that reaches it. With fewer
    // roots ahead of the new ones (only source-control's own, plus the shared types they name), any
    // finding the whole corpus would record under a new root is recorded under it here too, so an
    // empty result on this corpus is at least as strict — and it parses ~1/10 of the files.
    const units = [
      ...backendUnits(REPO_ROOT).filter((unit) => unit.path.startsWith(BACKEND_PREFIX + SC)),
      ...packageSrcUnits(REPO_ROOT, 'shared'),
    ]
    const NEW = /WorkspaceChange|WorkspaceWrite|RepositoryPublicationLog|workspaceChangePublication/
    const findings = publicSurfaceViolations(units)
    expect(findings.filter((line) => NEW.test(line))).toEqual([])
    // Positive control: the corpus does reach source-control's public roots (its known findings show up).
    expect(findings.some((line) => line.startsWith('modules/source-control/'))).toBe(true)
    // Negative control: the same judgement reports a function-typed property and the daemon Logger.
    const probe = [
      sourceUnit(
        BACKEND_PREFIX + 'modules/probe/public/types.ts',
        [
          "import type { Logger } from '@/util/log'",
          'export interface WorkspaceChangeProbe {',
          '  readonly acquire: () => Promise<() => void>',
          '  readonly log: Logger',
          '}',
        ].join('\n'),
      ),
    ]
    expect(publicSurfaceViolations(probe)).toEqual([
      'modules/probe/public/types.ts#WorkspaceChangeProbe: forbidden type import @/util/log#Logger',
      'modules/probe/public/types.ts#WorkspaceChangeProbe: unsafe/open type FunctionType',
    ])
  }, 120_000)

  test('模块根照旧转出同一个提交 binder，推送失败分类不再经 composition 转出', () => {
    expect(sourceControlComposition.bindRepositoryCommitParticipant).toBe(
      bindRepositoryCommitParticipant,
    )
    expect('classifyRepositoryPushFailure' in sourceControlComposition).toBe(false)
    expect(read(SC + 'composition.ts')).not.toContain(
      'export function bindRepositoryCommitParticipant',
    )
  })
})

describe('RFC-475 —— task-execution 的记账与转手', () => {
  test('commitPushBinding 取 infrastructure/commitPushAttempt 与 domain/commitAgent', () => {
    const path = TE + 'composition/commitPushBinding.ts'
    const binding = read(path)
    expect(sourceOfName(path, binding, 'runCommitPush')).toBe('../infrastructure/commitPushAttempt')
    for (const name of [
      'buildCommitAgent',
      'buildCommitMessagePrompt',
      'buildRepairPrompt',
      'COMMIT_MESSAGE_PORT',
      'commitPushNodeId',
    ])
      expect([name, sourceOfName(path, binding, name)]).toEqual([name, '../domain/commitAgent'])
    expect(
      specifiersIn(binding).filter((specifier) => specifier.startsWith('@/services/')),
    ).toEqual([])
  })

  test('public/queries 不再转出 repositoryPublicationOrdinal（唯一的模块外消费方已退役）', () => {
    expect(read(TE + 'public/queries.ts')).not.toMatch(/\brepositoryPublicationOrdinal\b/)
    // Positive control: the attempt takes it from domain inside the module.
    expect(sourceOfName(ATTEMPT, read(ATTEMPT), 'repositoryPublicationOrdinal')).toBe(
      '../domain/repositoryExecutionIdentity',
    )
  })

  test('util/git 的两个子仓列表函数给出原来的结果', () => {
    const entries = [
      { path: 'a', headSha: '1', flag: ' ' as const, pathDepth: 1 },
      { path: 'a/b/c', headSha: '2', flag: '+' as const, pathDepth: 3 },
      { path: 'gone', headSha: '3', flag: '-' as const, pathDepth: 1 },
      { path: 'a/b', headSha: '4', flag: 'U' as const, pathDepth: 2 },
      { path: 'z', headSha: '5', flag: ' ' as const, pathDepth: 1 },
    ]
    expect(usableSubmodules(entries).map((entry) => entry.path)).toEqual(['a', 'a/b/c', 'a/b', 'z'])
    // Deepest first; equal depth by path, descending — the order the parent's gitlink bumps need.
    expect(bottomUp(usableSubmodules(entries)).map((entry) => entry.path)).toEqual([
      'a/b/c',
      'a/b',
      'z',
      'a',
    ])
    expect(entries.map((entry) => entry.path)).toEqual(['a', 'a/b/c', 'gone', 'a/b', 'z'])
  })
})
