// RFC-585 — 节点隔离工作区的实现一族归 source-control（RFC-294 W5 余项第一步）。
//
// 为什么存在：`platform/workspace/local/` 的 `isolation`、`isolationReferences`、`submoduleParams` 与 `services/gitSubmodule` 原样迁入
// `modules/source-control/infrastructure/local/`；task-execution 的隔离视图删去只有用例在走的本机退路（搬进 `tests/helpers/nativeIsolationCleanup.ts`），
// 两个错误类挪到 source-control 的 domain、经 `public/types` 交出。锁四件事：
// ① 四个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它们（判据带负对照）。
// ② task-execution 的生产源码不取 source-control 的 infrastructure；隔离视图不再调用本机实现的函数（判据带负对照）。
// ③ platform 的源码不取 `services/`（判据带负对照）。
// ④ 两个错误类只在 source-control 的 `domain/isolationErrors.ts` 声明一次，并由 `public/types` 交出。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② 覆盖 task-execution 的全部生产源码；
// ③ 覆盖 `src/platform` 的全部源码；④ 读 backend `src`。隔离、快照、合并、冲突与清理的行为由既有用例覆盖（`rfc130-*`、`rfc210-*`、`rfc356-*`、
// `rfc370-isolation-*` 与 `rfc188-isolated-agent-run`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const SC = 'modules/source-control'
const slash = (path: string) => path.split('\\').join('/')

/** Old location below `src` (no extension) → new location below `src`. */
const MOVED: ReadonlyArray<readonly [string, string]> = [
  ['platform/workspace/local/isolation', `${SC}/infrastructure/local/nodeIsolation`],
  [
    'platform/workspace/local/isolationReferences',
    `${SC}/infrastructure/local/isolationReferences`,
  ],
  ['platform/workspace/local/submoduleParams', `${SC}/infrastructure/local/submoduleParams`],
  ['services/gitSubmodule', `${SC}/infrastructure/local/gitSubmodule`],
]
const OLD = new Set(MOVED.map(([old]) => `src/${old}`))
/** The native implementation functions Task Execution's view used to fall back to. */
const NATIVE_FALLBACKS = [
  'snapshotNodeIsoFinal',
  'mergeBackNodeIso',
  'discardIsolationWorkspace',
  'resolveConflictWithAgent',
] as const

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return []
    const path = join(dir, name)
    return statSync(path).isDirectory()
      ? walk(path)
      : /\.(?:[cm]?tsx?|mjs)$/.test(name)
        ? [path]
        : []
  })
}

/**
 * Every module specifier a file names — imports, re-exports, `import('…')` (types and calls), `require('…')` and
 * `mock.module('…')` — resolved to a path below the backend package without its extension (packages and paths that
 * leave the package are dropped).
 */
function resolvedTargets(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const add = (specifier: string) => {
    const bare = specifier.replace(/\.(?:[cm]?tsx?|[cm]?js)$/, '')
    const target = bare.startsWith('@/')
      ? join(SRC, bare.slice(2))
      : bare.startsWith('.')
        ? resolve(dirname(path), bare)
        : null
    if (target === null) return
    const below = slash(relative(BACKEND, target))
    if (!below.startsWith('..')) out.push(below)
  }
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier.text)
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      add(node.argument.literal.text)
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source)
      const first = node.arguments[0]
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          callee === 'require' ||
          callee === 'mock.module' ||
          callee === 'import.meta.resolve') &&
        first !== undefined &&
        ts.isStringLiteralLike(first)
      )
        add(first.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** Calls to the native implementation functions in a file (`name(`), by syntax tree. */
function nativeCalls(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (NATIVE_FALLBACKS as readonly string[]).includes(node.expression.text)
    )
      out.push(node.expression.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

describe('RFC-585 —— 四个文件离开 platform/ 与 services/', () => {
  test('旧路径不存在，新路径存在', () => {
    for (const [old, next] of MOVED) {
      expect([old, existsSync(join(SRC, `${old}.ts`))]).toEqual([old, false])
      expect([next, existsSync(join(SRC, `${next}.ts`))]).toEqual([next, true])
    }
  })

  test('src / tests / scripts 的全部说明符不再解析到旧路径', () => {
    const files = [
      ...walk(SRC),
      ...walk(join(BACKEND, 'tests')),
      ...walk(join(BACKEND, 'scripts')),
      ...walk(join(REPO, 'scripts')),
    ]
    expect(files.length).toBeGreaterThanOrEqual(6000)
    expect(
      files.flatMap((path) =>
        resolvedTargets(path, readFileSync(path, 'utf8'))
          .filter((target) => OLD.has(target))
          .map((target) => `${slash(relative(REPO, path))} -> ${target}`),
      ),
    ).toEqual([])
  }, 240_000)

  test('负对照：别名、相对路径、带扩展名、动态 import、mock.module 与 import 类型都会被认出；新位置与同目录的文件不算', () => {
    expect(
      resolvedTargets(
        join(BACKEND, 'tests', 'probe.test.ts'),
        "import { createNodeIso } from '@/platform/workspace/local/isolation'\n" +
          "import { x } from '../src/platform/workspace/local/submoduleParams.ts'\n" +
          "const sub = await import('../src/services/gitSubmodule')\n" +
          "mock.module('@/platform/workspace/local/isolationReferences', () => ({}))\n" +
          "import { createNodeIso as next } from '@/modules/source-control/infrastructure/local/nodeIsolation'\n" +
          "import { reclaimPath } from '@/platform/workspace/local/fsReclaim'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual([
      'src/platform/workspace/local/isolation',
      'src/platform/workspace/local/submoduleParams',
      'src/services/gitSubmodule',
      'src/platform/workspace/local/isolationReferences',
    ])
  })
})

describe('RFC-585 —— task-execution 不取 source-control 的实现', () => {
  test('task-execution 的生产源码不取 source-control 的 infrastructure', () => {
    const files = walk(join(SRC, 'modules', 'task-execution'))
    expect(files.length).toBeGreaterThan(300)
    expect(
      files.flatMap((path) =>
        resolvedTargets(path, readFileSync(path, 'utf8'))
          .filter((target) => target.startsWith(`src/${SC}/infrastructure/`))
          .map((target) => `${slash(relative(SRC, path))} -> ${target}`),
      ),
    ).toEqual([])
  }, 120_000)

  test('隔离视图不再调用本机实现的函数', () => {
    const path = join(
      SRC,
      'modules',
      'task-execution',
      'infrastructure',
      'isolationWorkspaceView.ts',
    )
    expect(nativeCalls(path, readFileSync(path, 'utf8'))).toEqual([])
  })

  test('负对照：别名与相对路径的取用、本机函数的调用都会被认出', () => {
    expect(
      resolvedTargets(
        join(SRC, 'modules', 'task-execution', 'infrastructure', 'probe.ts'),
        "import { createNodeIso } from '@/modules/source-control/infrastructure/local/nodeIsolation'\n" +
          "import { x } from '../../source-control/infrastructure/local/gitSubmodule'\n" +
          "import type { IsolationWorkspaceScope } from '@/modules/source-control/public/types'\n",
      ).filter((target) => target.startsWith(`src/${SC}/infrastructure/`)),
    ).toEqual([
      `src/${SC}/infrastructure/local/nodeIsolation`,
      `src/${SC}/infrastructure/local/gitSubmodule`,
    ])
    expect(
      nativeCalls(
        'probe.ts',
        'await snapshotNodeIsoFinal(handle)\nawait mergeBackNodeIso(handle, trees)\nawait record.scope.merge(workspace, trees)\n',
      ),
    ).toEqual(['snapshotNodeIsoFinal', 'mergeBackNodeIso'])
  })
})

describe('RFC-585 —— platform 不取 services/', () => {
  test('src/platform 的全部说明符不解析到 services/', () => {
    const files = walk(join(SRC, 'platform'))
    expect(files.length).toBeGreaterThan(300)
    expect(
      files.flatMap((path) =>
        resolvedTargets(path, readFileSync(path, 'utf8'))
          .filter((target) => target.startsWith('src/services/'))
          .map((target) => `${slash(relative(SRC, path))} -> ${target}`),
      ),
    ).toEqual([])
  }, 120_000)

  test('负对照：别名与相对路径都会被认出', () => {
    expect(
      resolvedTargets(
        join(SRC, 'platform', 'workspace', 'local', 'probe.ts'),
        "import { buildMergeResolvePrompt } from '@/services/mergeAgent'\n" +
          "import { syncSubmodules } from '../../../services/gitSubmodule'\n" +
          "import { reclaimPath } from './fsReclaim'\n",
      ).filter((target) => target.startsWith('src/services/')),
    ).toEqual(['src/services/mergeAgent', 'src/services/gitSubmodule'])
  })
})

describe('RFC-585 —— 两个错误类', () => {
  test('只在 source-control 的 domain 声明一次，并由 public/types 交出', () => {
    for (const name of ['IsoWorkspaceBlockedError', 'MergeAgentChildUnreapedError']) {
      const declaring = walk(SRC).filter((path) =>
        new RegExp(`\\bclass ${name}\\b`).test(readFileSync(path, 'utf8')),
      )
      expect([name, declaring.map((path) => slash(relative(SRC, path)))]).toEqual([
        name,
        [`${SC}/domain/isolationErrors.ts`],
      ])
    }
    const offered = readFileSync(join(SRC, SC, 'public', 'types.ts'), 'utf8')
    expect(offered).toContain(
      "export { IsoWorkspaceBlockedError, MergeAgentChildUnreapedError } from '../domain/isolationErrors'",
    )
  }, 120_000)
})
