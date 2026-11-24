// RFC-572 — `util/` 的进程 / 执行一族归 platform（RFC-294 W9-D 后继）。
//
// 为什么存在：`util/` 里的六个文件——跨平台的可执行文件解析、Windows 作业对象、进程存活与进程树终止、daemon 单实例锁、spawn 失败诊断与 tar 封装——
// 是一个闭合的依赖集，RFC-572 把它们原样迁进 platform（五个进 `platform/execution/local/`，`lock.ts` 改名 `daemonLock.ts`；tar 封装进
// `platform/persistence/`），读者一次改指，旧位置不留转出。锁四件事：
// ① 六个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符（别名、相对路径、动态 import、`mock.module`）再解析到它们（判据带负对照）。
// ② 新位置的六个文件只取登记过的依赖：彼此、`util/log`、node 内置模块与 `bun:ffi`——不取模块。
// ③ 每个文件导出的名字与搬迁前相同（含 daemon 锁转出的 `isProcessAlive`）。
// ④ Windows 平台工作流的 push 与 pull_request 两份路径清单都含执行目录的通配，都不含三个旧路径。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② ③ 只读六个新文件；④ 只读工作流文件。
// 各文件的行为由它们既有的用例覆盖（`process.test`、`lock.test`、`rfc254-platform-exec`、`rfc356-process-tree-quiesce`、`rfc396-windows-flat-process-group`、
// `rfc213` 的备份与还原等），Windows 上的行为由 windows-platform 工作流覆盖。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

/** Old location (below `src`, no extension) → new location, with the names each file exported before the move and its imports. */
const MOVED: ReadonlyArray<readonly [string, string, readonly string[], readonly string[]]> = [
  [
    'util/platformExec',
    'platform/execution/local/platformExec',
    [
      'EXECUTABLE_SUFFIX_FOR_HOST',
      'GIT_NULL_CONFIG_PATH',
      'NULL_DEVICE_FOR_HOST',
      'SEALED_SHELL_SUPPORTED',
      'buildControlledPath',
      'buildControlledPathForHost',
      'buildScriptPath',
      'controlledSystemPathEntries',
      'disabledShellCommand',
      'disabledShellCommandForHost',
      'executableSuffix',
      'isLexicallyInside',
      'isLexicallyInsideForHost',
      'nullDevice',
      'pathListJoin',
      'pathListJoinForHost',
      'pathListSplit',
      'pathListSplitForHost',
      'platformHomeEnv',
      'platformHomeEnvForHost',
      'platformSpawnOptions',
      'platformSpawnOptionsForHost',
      'resolveGitToolDirectory',
      'toPortableRelativePath',
    ],
    ['node:path'],
  ],
  [
    'util/windowsJobObject',
    'platform/execution/local/windowsJobObject',
    [
      'ProcessTreeOwnership',
      'WIN32_JOB_LAYOUT',
      'adoptProcessTree',
      'processTreeOwnershipAvailable',
      'processTreeOwnershipDiagnosis',
      'resetKernel32CacheForTests',
    ],
    ['bun:ffi'],
  ],
  [
    'util/process',
    'platform/execution/local/process',
    [
      'DEFAULT_VERSION_PROBE_TIMEOUT_MS',
      'KillTreeSignal',
      'ProcessLivenessOptions',
      'STALE_RUN_PID_MAX_AGE_MS',
      'STALE_RUN_QUIESCE_BUDGET_MS',
      'StaleRunKillOpts',
      'StaleRunKillOutcome',
      'TREE_QUIESCE_BUDGET_MS',
      'TreeQuiesceLog',
      'TreeQuiesceOutcome',
      'VersionProbeOpts',
      'VersionProbeResult',
      'adoptSpawnedProcessTree',
      'awaitProcessTreeQuiesced',
      'detachedProcessGroup',
      'isProcessAlive',
      'isProcessTreeAlive',
      'killProcessTree',
      'killStaleRunProcessTree',
      'pidCommandContainsBinary',
      'pidCommandContainsLaunchIdentity',
      'pidCommandLooksLikeAgentChild',
      'processTreeOwnershipStatus',
      'raceWithFallback',
      'readStreamCapped',
      'reapDetachedGroup',
      'releaseProcessTreeOwnership',
      'spawnVersionProbe',
    ],
    [
      '@/platform/execution/local/platformExec',
      '@/platform/execution/local/windowsJobObject',
      '@/util/log',
    ],
  ],
  [
    'util/lock',
    'platform/execution/local/daemonLock',
    [
      'DaemonLockHeldError',
      'Lock',
      'acquireLock',
      'adoptCurrentProcessLock',
      'isProcessAlive',
      'readPidFromLock',
      'writePidFileForTest',
    ],
    ['./process', 'node:fs', 'node:path'],
  ],
  [
    'util/spawnDiagnostics',
    'platform/execution/local/spawnDiagnostics',
    ['SpawnEnoentContext', 'SpawnEnoentProbes', 'explainSpawnEnoent', 'outputTail'],
    ['node:fs', 'node:path'],
  ],
  [
    'util/archive',
    'platform/persistence/archive',
    ['extractTarGz', 'resetTarProbeForTests', 'tarAvailable', 'tarBin', 'tarGz'],
    ['@/platform/execution/local/platformExec', 'node:fs', 'node:path'],
  ],
]
const OLD = new Set(MOVED.map(([old]) => old))

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
 * `mock.module('…')` — resolved to a path below `src` without its extension (null when it leaves `src` or is a package).
 */
function resolvedSpecifiers(path: string, text: string): string[] {
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
    const below = slash(relative(SRC, target))
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

/** Names a file exports with an `export` modifier (functions, classes, consts, interfaces, type aliases). */
function exportedNames(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  return source.statements
    .flatMap((statement) => {
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause)
      )
        return statement.exportClause.elements.map((element) => element.name.text)
      const exported =
        ts.canHaveModifiers(statement) &&
        (ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
          false)
      if (!exported) return []
      if (ts.isVariableStatement(statement))
        return statement.declarationList.declarations.flatMap((declaration) =>
          ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
        )
      return (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
        statement.name !== undefined
        ? [statement.name.text]
        : []
    })
    .sort()
}

/** The raw module specifiers of a file's import and export declarations. */
function rawSpecifiers(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  )
}

describe('RFC-572 —— 六个文件离开 util/', () => {
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
        resolvedSpecifiers(path, readFileSync(path, 'utf8'))
          .filter((target) => OLD.has(target))
          .map((target) => `${slash(relative(REPO, path))} -> ${target}`),
      ),
    ).toEqual([])
  }, 240_000)

  test('负对照：别名、相对路径、带扩展名、动态 import、require、mock.module 与 import 类型都会被认出；新路径与包名不算', () => {
    const fromSrcRoot = join(SRC, 'main.ts')
    expect(
      resolvedSpecifiers(
        fromSrcRoot,
        "import { killProcessTree } from './util/process'\n" +
          "import { acquireLock } from '@/util/lock'\n" +
          "export { tarGz } from './util/archive.ts'\n" +
          "const exec = await import('./util/platformExec')\n" +
          "const job = require('./util/windowsJobObject')\n" +
          "mock.module('@/util/spawnDiagnostics', () => ({}))\n" +
          "type K = import('./util/process').KillTreeSignal\n" +
          "import { acquireLock as next } from './platform/execution/local/daemonLock'\n" +
          "import { createLogger } from './util/log'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual([
      'util/process',
      'util/lock',
      'util/archive',
      'util/platformExec',
      'util/windowsJobObject',
      'util/spawnDiagnostics',
      'util/process',
    ])
    const fromTests = join(BACKEND, 'tests', 'helpers', 'probe.ts')
    expect(
      resolvedSpecifiers(
        fromTests,
        "import { tarGz } from '../../src/util/archive'\n" +
          "import { tarGz as next } from '../../src/platform/persistence/archive'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['util/archive'])
  })
})

describe('RFC-572 —— 新位置的文件', () => {
  test('只取登记过的依赖：彼此、util/log、node 内置模块与 bun:ffi；不取模块', () => {
    for (const [, next, , specifiers] of MOVED) {
      const found = rawSpecifiers(join(SRC, `${next}.ts`)).sort()
      expect([next, found]).toEqual([next, [...specifiers].sort()])
      expect([next, found.filter((specifier) => specifier.includes('/modules/'))]).toEqual([
        next,
        [],
      ])
    }
  })

  test('导出的名字与搬迁前相同', () => {
    for (const [, next, names] of MOVED)
      expect([next, exportedNames(join(SRC, `${next}.ts`))]).toEqual([next, [...names].sort()])
  })
})

describe('RFC-572 —— Windows 平台工作流的路径清单', () => {
  test('两份清单都含执行目录的通配，都不含三个旧路径，且逐行相同', () => {
    const workflow = readFileSync(
      join(REPO, '.github', 'workflows', 'windows-platform.yml'),
      'utf8',
    )
    const lists = workflow
      .split(/\n\s*paths:\n/)
      .slice(1)
      .map((block) => {
        const lines: string[] = []
        for (const line of block.split('\n')) {
          const entry = /^\s+- '([^']+)'\s*$/.exec(line)
          if (entry !== null) lines.push(entry[1]!)
          else if (!/^\s*(#.*)?$/.test(line)) break
        }
        return lines
      })
    expect(lists.length).toBe(2)
    for (const list of lists) {
      expect(list).toContain('packages/backend/src/platform/execution/local/**')
      expect(
        list.filter((entry) =>
          /src\/util\/(?:platformExec|process|windowsJobObject)\.ts$/.test(entry),
        ),
      ).toEqual([])
      expect(list.length).toBeGreaterThanOrEqual(30)
    }
    expect(lists[0]).toEqual(lists[1]!)
  })

  test('负对照：同一读法认得出清单里的旧路径', () => {
    const sample =
      "on:\n  push:\n    paths:\n      - 'packages/backend/src/util/process.ts'\n      # note\n      - 'x/**'\njobs:\n"
    const block = sample.split(/\n\s*paths:\n/)[1]!
    const lines: string[] = []
    for (const line of block.split('\n')) {
      const entry = /^\s+- '([^']+)'\s*$/.exec(line)
      if (entry !== null) lines.push(entry[1]!)
      else if (!/^\s*(#.*)?$/.test(line)) break
    }
    expect(lines).toEqual(['packages/backend/src/util/process.ts', 'x/**'])
  })
})
