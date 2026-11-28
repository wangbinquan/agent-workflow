// RFC-622 — source-control 的候选与提交绑定器迁入 application（RFC-294 S10 余项：`composition-control-flow-source-control` 4 → 0）。
//
// 为什么存在：`bindChangeCandidateParticipant` / `bindCandidateDeliveryParticipant`（选托管的操作宿主还是本进程的本地步骤）与
// `bindRepositoryCommitParticipant`（有工作区作用域时在它的卷里跑、否则在本进程跑）决定的是“由哪一面执行用例”——用例编排，属于
// application；组合层只装配部署的选择。三个函数原样迁入 `application/repositoryCandidateParticipants.ts` 与
// `application/repositoryCommitParticipant.ts`，模块根 `composition.ts` 照旧转出它们（bootstrap 的取法不变），`composition/repositoryCommit.ts`
// 删除，`composition/repositoryCandidate.ts` 只剩本地夹具的装配。锁四件事：
// ① 旧的提交绑定文件不在；三个绑定器只在两个 application 文件里声明，组合层里不再声明；模块根 `composition.ts` 从 application 转出它们。
// ② 两个 application 文件只取本模块的 application、domain 与 public 类型，不取 composition / infrastructure，也不取别的模块。
// ③ backend 的 `src`、`tests`、`scripts` 与仓库根的 `scripts`、`tests` 里没有文件再经任何写法取旧的提交绑定文件，也没有文件从
//    `composition/repositoryCandidate` 取两个候选绑定器（语料下限 3,000）。
// ④ 负对照（伪造源码）：上面每条判据都认得出违例，近似名与字符串里的路径不算。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const SC = 'modules/source-control/'
const CANDIDATE_APP = SC + 'application/repositoryCandidateParticipants'
const COMMIT_APP = SC + 'application/repositoryCommitParticipant'
const OLD_COMMIT = SC + 'composition/repositoryCommit'
const OLD_CANDIDATE = SC + 'composition/repositoryCandidate'
const BINDERS: Readonly<Record<string, string>> = {
  bindChangeCandidateParticipant: CANDIDATE_APP,
  bindCandidateDeliveryParticipant: CANDIDATE_APP,
  bindRepositoryCommitParticipant: COMMIT_APP,
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.(?:[cm]?ts|mjs)$/.test(name) ? [path] : []
  })
}

interface Site {
  readonly specifier: string
  readonly names: readonly string[]
}

/**
 * Every module specifier a file names on the syntax tree, with the names an import or re-export binds — imports,
 * re-exports, `import('…')`, `require('…')` and `mock.module('…')` — so paths quoted inside other strings never count.
 */
function sites(path: string, text: string): Site[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: Site[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings
      out.push({
        specifier: node.moduleSpecifier.text,
        names:
          bindings !== undefined && ts.isNamedImports(bindings)
            ? bindings.elements.map((element) => (element.propertyName ?? element.name).text)
            : [],
      })
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      out.push({
        specifier: node.moduleSpecifier.text,
        names:
          node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements.map(
                (element) => (element.propertyName ?? element.name).text,
              )
            : [],
      })
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression.getText(source)
      const first = node.arguments[0]!
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          callee === 'require' ||
          callee === 'mock.module') &&
        ts.isStringLiteralLike(first)
      )
        out.push({ specifier: first.text, names: [] })
    }
    node.forEachChild(visit)
  }
  visit(source)
  return out
}

/** The path below `src` a specifier reaches, without its extension, or null for a package. */
function targetOf(path: string, specifier: string): string | null {
  const resolved = specifier.startsWith('@/')
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? normalize(join(dirname(path), specifier))
      : null
  return resolved === null
    ? null
    : relative(SRC, resolved)
        .replaceAll('\\', '/')
        .replace(/\.(?:ts|js|mjs)$/, '')
}

/** Function names a file declares. */
function declaredFunctions(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name !== undefined
      ? [statement.name.text]
      : [],
  )
}

/** Imports of an application binder file that leave the module's application, domain and public types. */
function layerLeaks(path: string, text: string): string[] {
  return sites(path, text)
    .map((site) => site.specifier)
    .filter((specifier) => {
      const target = targetOf(path, specifier)
      if (target === null)
        return !specifier.startsWith('node:') && specifier !== '@agent-workflow/shared'
      return !/^modules\/source-control\/(?:application|domain|public)\//.test(target)
    })
}

/** Old-path findings in one file: any specifier reaching the old commit file, and candidate binders taken from composition. */
function oldPathFindings(path: string, text: string): string[] {
  return sites(path, text).flatMap((site) => {
    const target = targetOf(path, site.specifier)
    if (target === OLD_COMMIT) return [site.specifier]
    if (target === OLD_CANDIDATE)
      return site.names.filter((name) => name in BINDERS).map((name) => `${site.specifier}#${name}`)
    return []
  })
}

describe('RFC-622 —— source-control 的候选与提交绑定器迁入 application', () => {
  test('旧提交绑定文件不在；三个绑定器只在 application 声明；模块根从 application 转出', () => {
    expect(existsSync(join(SRC, `${OLD_COMMIT}.ts`))).toBe(false)
    for (const [name, file] of Object.entries(BINDERS)) {
      const path = join(SRC, `${file}.ts`)
      expect([name, declaredFunctions(path, readFileSync(path, 'utf8')).includes(name)]).toEqual([
        name,
        true,
      ])
    }
    const composition = walk(join(SRC, SC + 'composition'))
    expect(composition.length).toBeGreaterThan(10)
    expect(
      composition.flatMap((path) =>
        declaredFunctions(path, readFileSync(path, 'utf8'))
          .filter((name) => name in BINDERS)
          .map((name) => `${relative(SRC, path)} declares ${name}`),
      ),
    ).toEqual([])
    const root = join(SRC, SC + 'composition.ts')
    const reexports = sites(root, readFileSync(root, 'utf8')).flatMap((site) =>
      site.names
        .filter((name) => name in BINDERS)
        .map((name) => [name, targetOf(root, site.specifier)] as const),
    )
    expect(Object.fromEntries(reexports)).toEqual(BINDERS)
  })

  test('两个 application 文件只取本模块的 application、domain 与 public 类型', () => {
    for (const file of [CANDIDATE_APP, COMMIT_APP]) {
      const path = join(SRC, `${file}.ts`)
      expect([file, layerLeaks(path, readFileSync(path, 'utf8'))]).toEqual([file, []])
    }
  })

  // RFC-629: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.
})

describe('RFC-622 —— 负对照（伪造源码）', () => {
  test('判据认得出取旧提交文件与从组合层取候选绑定器，夹具工厂与字符串里的路径不算', () => {
    expect(
      oldPathFindings(
        join(BACKEND, 'tests', 'probe.test.ts'),
        [
          "import { bindRepositoryCommitParticipant } from '@/modules/source-control/composition/repositoryCommit'",
          "import { bindChangeCandidateParticipant, createLocalRepositoryCandidateEffects } from '../src/modules/source-control/composition/repositoryCandidate'",
          "mock.module('@/modules/source-control/composition/repositoryCommit', () => ({}))",
          "import { createLocalRepositoryCandidateEffects as local } from '@/modules/source-control/composition/repositoryCandidate'",
          'const quoted = "import x from \'@/modules/source-control/composition/repositoryCommit\'"',
        ].join('\n'),
      ),
    ).toEqual([
      '@/modules/source-control/composition/repositoryCommit',
      '../src/modules/source-control/composition/repositoryCandidate#bindChangeCandidateParticipant',
      '@/modules/source-control/composition/repositoryCommit',
    ])
  })

  test('判据认得出 application 绑定文件取组合层、基础设施或别的模块', () => {
    expect(
      layerLeaks(
        join(SRC, SC + 'application', 'probe.ts'),
        [
          "import { requireRepositoryGitWorkspaceScope } from '../composition/repositoryGitWorkspaces'",
          "import { createFileRepositoryCandidateEffectsFactory } from '../infrastructure/local/fileRepositoryCandidateEffects'",
          "import type { Task } from '@/modules/task-execution/public/types'",
          "import { commitCandidate } from './deliverCandidate'",
          "import type { RepositoryPublicationTransport } from '../public/types'",
        ].join('\n'),
      ),
    ).toEqual([
      '../composition/repositoryGitWorkspaces',
      '../infrastructure/local/fileRepositoryCandidateEffects',
      '@/modules/task-execution/public/types',
    ])
  })
})
