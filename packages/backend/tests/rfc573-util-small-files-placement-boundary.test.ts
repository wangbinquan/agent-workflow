// RFC-573 — `util/` 的四个余下小文件归位（RFC-294 W9-D 后继）。
//
// 为什么存在：`util/` 里还有四个既不属于“读者数百处”的五个大文件、也不属于 git / 凭据 / 文件信任一族的小文件。RFC-573 把三个平台机制原样迁进
// platform（超时信号进 `platform/contracts/`，工作区目录的回收进 `platform/workspace/local/`，迁移目录的解析进
// `platform/persistence/migration/`），把读 daemon 运行信息文件的那一个并入它的 owner——system-operations 里 `DaemonRuntimeQueries` 端口的文件
// 实现——并让 `agent-workflow status` 经这个端口读、由 bootstrap 交入实现。锁五件事：
// ① 四个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符（别名、相对路径、动态 import、`mock.module`）再解析到它们（判据带负对照）。
// ② 迁入 platform 的三个文件只取登记过的依赖，不取模块。
// ③ 这三个文件导出的名字与搬迁前相同。
// ④ `cli/status.ts` 对模块只有 system-operations public 的类型 import；`statusCommand` 经交入的端口读运行信息；bootstrap 交入的是
//    system-operations 装配根给出的文件实现，`main.ts` 把它交给命令。行为：端口给什么、命令就报什么；文件实现对缺失与损坏的文件返回 null。
// ⑤ Windows 平台工作流的 push 与 pull_request 两份路径清单都含 `fsReclaim` 的新路径、都不含旧路径，且逐行相同。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② ③ 只读三个新文件；④ 只读
// `cli/status.ts`、`bootstrap/commandBootstraps.ts`、`main.ts` 与 system-operations 的两个文件，行为断言跑真实的命令与文件实现；⑤ 只读工作流文件。
// 三个平台文件的行为由既有用例覆盖（`rfc356-workspace-reclaim`、`cli-embedded-migrations`、`rfc254-no-unref-deadline-guard` 与各读者的用例）。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { composeStatusCommandDaemonRuntime } from '../src/bootstrap/commandBootstraps'
import { statusCommand } from '../src/cli/status'
import {
  createFileDaemonRuntimeQueries,
  readDaemonInfoFile,
} from '../src/modules/system-operations/infrastructure/local/fileDaemonRuntimeQueries'
import type { DaemonRuntimeInfo } from '../src/modules/system-operations/public/types'
import { writePidFileForTest } from '../src/platform/execution/local/daemonLock'
import { Paths } from '../src/platform/configuration/installationPaths'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

/** Old location (below `src`, no extension) → new location, with the names each file exported before the move and its imports. */
const MOVED: ReadonlyArray<readonly [string, string, readonly string[], readonly string[]]> = [
  [
    'util/timeoutSignal',
    'platform/contracts/timeoutSignal',
    ['TimeoutSignal', 'timeoutSignal'],
    [],
  ],
  [
    'util/fsReclaim',
    'platform/workspace/local/fsReclaim',
    ['DEFAULT_RECLAIM_DELAYS_MS', 'RemoveDirectoryWithRetryResult', 'removeDirectoryWithRetry'],
    ['@/platform/logging/logger', 'node:fs', 'node:fs/promises'],
  ],
  [
    'util/migrationsFolder',
    'platform/persistence/migration/migrationsFolder',
    ['ResolveMigrationsOptions', 'resolveMigrationsFolder', 'resolvePostgresqlMigrationsFolder'],
    ['@/embed', '@/platform/configuration/installationPaths', 'node:fs', 'node:path'],
  ],
]
/** The fourth file did not move as a file: its one function joined the file implementation of the query port. */
const DAEMON_INFO = 'util/daemonInfo'
const OLD = new Set([...MOVED.map(([old]) => old), DAEMON_INFO])

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

describe('RFC-573 —— 四个文件离开 util/', () => {
  test('旧路径不存在，新路径存在', () => {
    for (const [old, next] of MOVED) {
      expect([old, existsSync(join(SRC, `${old}.ts`))]).toEqual([old, false])
      expect([next, existsSync(join(SRC, `${next}.ts`))]).toEqual([next, true])
    }
    expect(existsSync(join(SRC, `${DAEMON_INFO}.ts`))).toBe(false)
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
        "import { timeoutSignal } from './util/timeoutSignal'\n" +
          "import { removeDirectoryWithRetry } from '@/util/fsReclaim'\n" +
          "export { resolveMigrationsFolder } from './util/migrationsFolder.ts'\n" +
          "const info = await import('./util/daemonInfo')\n" +
          "const reclaim = require('./util/fsReclaim')\n" +
          "mock.module('@/util/migrationsFolder', () => ({}))\n" +
          "type Info = import('./util/daemonInfo').DaemonInfo\n" +
          "import { timeoutSignal as next } from './platform/contracts/timeoutSignal'\n" +
          "import { createLogger } from './platform/logging/logger'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual([
      'util/timeoutSignal',
      'util/fsReclaim',
      'util/migrationsFolder',
      'util/daemonInfo',
      'util/fsReclaim',
      'util/migrationsFolder',
      'util/daemonInfo',
    ])
    const fromTests = join(BACKEND, 'tests', 'helpers', 'probe.ts')
    expect(
      resolvedSpecifiers(
        fromTests,
        "import { readDaemonInfo } from '../../src/util/daemonInfo'\n" +
          "import { readDaemonInfoFile } from '../../src/modules/system-operations/infrastructure/local/fileDaemonRuntimeQueries'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['util/daemonInfo'])
  })
})

describe('RFC-573 —— 迁入 platform 的三个文件', () => {
  test('只取登记过的依赖，不取模块', () => {
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

/** Import declarations of a file as `[specifier, type-only?]`. */
function importKinds(path: string, text = readFileSync(path, 'utf8')): [string, boolean][] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement): [string, boolean][] =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      ? [[statement.moduleSpecifier.text, statement.importClause?.isTypeOnly === true]]
      : [],
  )
}

/** Module imports of the status command that are not type-only imports from system-operations' public surface. */
function statusCommandModuleLeaks(text: string): string[] {
  return importKinds(join(SRC, 'cli', 'status.ts'), text)
    .filter(([specifier]) => specifier.includes('/modules/'))
    .filter(
      ([specifier, typeOnly]) =>
        !typeOnly || !/^@\/modules\/system-operations\/public\/(?:queries|types)$/.test(specifier),
    )
    .map(([specifier, typeOnly]) => `${typeOnly ? 'type' : 'value'} ${specifier}`)
}

/** The top-level function declaration with this name. */
function functionNamed(path: string, name: string): ts.FunctionDeclaration {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const found = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  )
  if (found === undefined) throw new Error(`${name} is not declared in ${path}`)
  return found
}

const compact = (node: ts.Node) => node.getText().replace(/\s+/g, '')

describe('RFC-573 —— status 命令经端口读运行信息', () => {
  const STATUS = join(SRC, 'cli', 'status.ts')
  const HEALTH = { ok: true, opencodeVersion: null, dbVersion: 7, uptime: 3, runningTasks: 0 }
  let home: string
  let previousHome: string | undefined
  // The command probes `/health` at the address the run-info names. A loopback listener answers at once on every
  // platform; a closed port would cost Windows about two seconds per refused connection.
  let listener: ReturnType<typeof Bun.serve>
  let sample: DaemonRuntimeInfo

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'aw-rfc573-'))
    previousHome = process.env.AGENT_WORKFLOW_HOME
    process.env.AGENT_WORKFLOW_HOME = home
    listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json(HEALTH) })
    sample = {
      pid: 4321,
      host: '127.0.0.1',
      port: listener.port!,
      url: `http://127.0.0.1:${listener.port}/`,
      startedAt: '2026-11-24T00:00:00.000Z',
    }
  })

  afterEach(async () => {
    await listener.stop(true)
    if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  test('cli/status.ts 对模块只有 system-operations public 的类型 import', () => {
    expect(statusCommandModuleLeaks(readFileSync(STATUS, 'utf8'))).toEqual([])
    expect(
      importKinds(STATUS)
        .map(([specifier]) => specifier)
        .sort(),
    ).toEqual([
      '@/modules/system-operations/public/queries',
      '@/modules/system-operations/public/types',
      '@/platform/configuration/installationPaths',
      '@/platform/execution/local/daemonLock',
    ])
  })

  test('负对照：值 import、取 infrastructure 或 composition、取别的模块都会被认出', () => {
    expect(
      statusCommandModuleLeaks(
        "import type { DaemonRuntimeQueries } from '@/modules/system-operations/public/queries'\n" +
          "import { readDaemonInfoFile } from '@/modules/system-operations/infrastructure/local/fileDaemonRuntimeQueries'\n" +
          "import { createFileDaemonRuntimeQueries } from '@/modules/system-operations/composition/daemonHostLifecycle'\n" +
          "import { something } from '@/modules/system-operations/public/queries'\n" +
          "import type { Task } from '@/modules/task-execution/public/types'\n",
      ),
    ).toEqual([
      'value @/modules/system-operations/infrastructure/local/fileDaemonRuntimeQueries',
      'value @/modules/system-operations/composition/daemonHostLifecycle',
      'value @/modules/system-operations/public/queries',
      'type @/modules/task-execution/public/types',
    ])
  })

  test('statusCommand 只有一个入参（查询端口），运行信息只经它读', () => {
    const command = functionNamed(STATUS, 'statusCommand')
    expect(command.parameters.map((parameter) => parameter.getText())).toEqual([
      'daemonRuntime: DaemonRuntimeQueries',
    ])
    const body = compact(command.body!)
    expect(body.split('daemonRuntime.readCurrent()').length - 1).toBe(1)
    expect(body).toContain('awaitdaemonRuntime.readCurrent()')
    expect(body).not.toContain('readDaemonInfo')
    expect(body).not.toContain('readFileSync')
  })

  test('bootstrap 交入 system-operations 装配根给出的文件实现，main.ts 把它交给命令', () => {
    const bootstraps = join(SRC, 'bootstrap', 'commandBootstraps.ts')
    expect(compact(functionNamed(bootstraps, 'composeStatusCommandDaemonRuntime').body!)).toBe(
      '{returncreateFileDaemonRuntimeQueries()}',
    )
    expect(
      importKinds(bootstraps).filter(([specifier]) => specifier.includes('daemonHostLifecycle')),
    ).toEqual([['@/modules/system-operations/composition/daemonHostLifecycle', false]])
    const composition = readFileSync(
      join(SRC, 'modules', 'system-operations', 'composition', 'daemonHostLifecycle.ts'),
      'utf8',
    )
    expect(composition.replace(/\s+/g, '')).toContain(
      "export{createFileDaemonRuntimeQueries}from'../infrastructure/local/fileDaemonRuntimeQueries'",
    )
    const main = readFileSync(join(SRC, 'main.ts'), 'utf8').replace(/\s+/g, '')
    expect(main).toContain('awaitstatusCommand(composeStatusCommandDaemonRuntime())')
    expect(main.split('statusCommand(').length - 1).toBe(1)
  })

  test('行为：没有锁文件时不读运行信息', async () => {
    let reads = 0
    const result = await statusCommand({
      readCurrent: () => {
        reads += 1
        return sample
      },
    })
    expect(result).toEqual({ state: 'not-running' })
    expect(reads).toBe(0)
  })

  test('行为：锁里是活着的进程时，端口给什么、命令就报什么（同步与异步的端口都行）', async () => {
    writePidFileForTest(Paths.lock, process.pid)
    const fromSync = await statusCommand({ readCurrent: () => sample })
    // The health probe goes to the address the port's answer names.
    expect(fromSync).toEqual({ state: 'running', pid: process.pid, info: sample, health: HEALTH })

    const fromAsync = await statusCommand({ readCurrent: async () => sample })
    expect(fromAsync).toEqual({ state: 'running', pid: process.pid, info: sample, health: HEALTH })

    const withoutInfo = await statusCommand({ readCurrent: () => null })
    expect(withoutInfo).toEqual({ state: 'running', pid: process.pid })
  })

  test('行为：bootstrap 交入的实现读的是安装目录里的运行信息文件', async () => {
    writePidFileForTest(Paths.lock, process.pid)
    expect((await statusCommand(composeStatusCommandDaemonRuntime())).info).toBeUndefined()
    writeFileSync(Paths.daemonInfo, JSON.stringify(sample))
    expect((await statusCommand(composeStatusCommandDaemonRuntime())).info).toEqual(sample)
  })

  test('行为：文件实现对存在、缺失与损坏的文件', async () => {
    const present = join(home, 'present.info')
    const garbled = join(home, 'garbled.info')
    writeFileSync(present, JSON.stringify(sample))
    writeFileSync(garbled, '{ not json')
    expect(readDaemonInfoFile(present)).toEqual(sample)
    expect(readDaemonInfoFile(join(home, 'absent.info'))).toBeNull()
    expect(readDaemonInfoFile(garbled)).toBeNull()
    expect(await createFileDaemonRuntimeQueries({ infoPath: present }).readCurrent()).toEqual(
      sample,
    )
    expect(await createFileDaemonRuntimeQueries({ infoPath: garbled }).readCurrent()).toBeNull()
    // No path given: the installation's own run-info file.
    expect(await createFileDaemonRuntimeQueries().readCurrent()).toBeNull()
    writeFileSync(Paths.daemonInfo, JSON.stringify(sample))
    expect(await createFileDaemonRuntimeQueries().readCurrent()).toEqual(sample)
  })
})

/** The entries of every `paths:` list in a workflow file, one array per list. */
function pathLists(workflow: string): string[][] {
  return workflow
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
}

describe('RFC-573 —— Windows 平台工作流的路径清单', () => {
  test('两份清单都含 fsReclaim 的新路径，都不含旧路径，且逐行相同', () => {
    const lists = pathLists(
      readFileSync(join(REPO, '.github', 'workflows', 'windows-platform.yml'), 'utf8'),
    )
    expect(lists.length).toBe(2)
    for (const list of lists) {
      expect(list).toContain('packages/backend/src/platform/workspace/local/fsReclaim.ts')
      expect(list.filter((entry) => entry.endsWith('src/util/fsReclaim.ts'))).toEqual([])
      expect(list.length).toBeGreaterThanOrEqual(30)
    }
    expect(lists[0]).toEqual(lists[1]!)
  })

  test('负对照：同一读法认得出清单里的旧路径', () => {
    expect(
      pathLists(
        "on:\n  push:\n    paths:\n      - 'packages/backend/src/util/fsReclaim.ts'\n      # note\n      - 'x/**'\njobs:\n",
      ),
    ).toEqual([['packages/backend/src/util/fsReclaim.ts', 'x/**']])
  })
})
