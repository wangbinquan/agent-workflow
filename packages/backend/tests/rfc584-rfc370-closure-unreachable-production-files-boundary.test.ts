// RFC-584 — RFC-370 收口后的不可达生产文件（RFC-294 S11 余项）。
//
// 为什么存在：RFC-375 把只供 RFC-370 契约用例的兼容入口留到“RFC-370 收口”；RFC-370 已 Done，本 RFC 把其中五个原样迁入 `tests/helpers/`，删除
// MCP 诊断的一跳旧地址与 RFC-503 之前直接读写文件系统的 Intent 维护副本（`rfc234-turn-engine` 的维护用例改测生产的维护命令）。锁三件事：
// ① 七个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它们（判据带负对照）。
// ② 五个迁走的文件在 `tests/helpers/`；生产源码没有任何说明符解析到 `tests/`（判据带负对照）。
// ③ `rfc234-turn-engine` 的维护用例取 intent composition 的生产命令，副本的三个函数名不再出现。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② 覆盖 backend `src` 的全部文件；③ 只读
// `rfc234-turn-engine`。不可达生产文件与 application 直接效果文件的计数由 `rfc376-structural-guards` 执行。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { RFC584_RETIRED as RETIRED } from './helpers/rfc624MigrationReferenceRules'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

const OLD = new Set(RETIRED.map(([old]) => `src/${old}`))

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

describe('RFC-584 —— 七个文件离开生产树', () => {
  test('旧路径不存在；迁走的五个在 tests/helpers/', () => {
    for (const [old, next] of RETIRED) {
      expect([old, existsSync(join(SRC, `${old}.ts`))]).toEqual([old, false])
      if (next !== null)
        expect([next, existsSync(join(BACKEND, `${next}.ts`))]).toEqual([next, true])
    }
  })

  // RFC-629: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.

  test('负对照：别名、相对路径、带扩展名、动态 import、mock.module 与 import 类型都会被认出；新位置与同前缀的文件不算', () => {
    expect(
      resolvedTargets(
        join(BACKEND, 'tests', 'probe.test.ts'),
        "import { materializeActionWorkspace } from '@/modules/development-automation/infrastructure/actionWorkspace'\n" +
          "import { x } from '../src/modules/intent/application/maintenance.ts'\n" +
          "const run = await import('../src/modules/task-execution/composition/systemAgentRun')\n" +
          "mock.module('@/modules/resource-catalog/infrastructure/mcpDiagnosticsEffects', () => ({}))\n" +
          "export type Probe = typeof import('@/modules/event-center/infrastructure/customEventObserverProgram')\n" +
          "import { runPreparedSystemAgent } from './helpers/preparedSystemAgentRun'\n" +
          "import { createIntentMaintenanceCommands } from '@/modules/intent/application/maintenanceCommands'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual([
      'src/modules/development-automation/infrastructure/actionWorkspace',
      'src/modules/intent/application/maintenance',
      'src/modules/task-execution/composition/systemAgentRun',
      'src/modules/resource-catalog/infrastructure/mcpDiagnosticsEffects',
      'src/modules/event-center/infrastructure/customEventObserverProgram',
    ])
  })
})

describe('RFC-584 —— 生产源码不取用例辅助文件', () => {
  test('backend src 的全部说明符不解析到 tests/', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThanOrEqual(1500)
    expect(
      files.flatMap((path) => {
        const text = readFileSync(path, 'utf8')
        if (!text.includes('tests') && !text.includes('\\u') && !text.includes('\\x')) return []
        return resolvedTargets(path, text)
          .filter((target) => target.startsWith('tests/'))
          .map((target) => `${slash(relative(REPO, path))} -> ${target}`)
      }),
    ).toEqual([])
  }, 120_000)

  test('负对照：相对路径与越出 src 的别名都会被认出', () => {
    expect(
      resolvedTargets(
        join(SRC, 'modules', 'task-execution', 'composition', 'probe.ts'),
        "import { runPreparedSystemAgent } from '../../../../tests/helpers/preparedSystemAgentRun'\n" +
          "import { adoptActionWorkspace } from '@/../tests/helpers/developmentActionWorkspace'\n" +
          "import { runSystemAgentCore } from '../application/systemAgentRun'\n",
      ).filter((target) => target.startsWith('tests/')),
    ).toEqual(['tests/helpers/preparedSystemAgentRun', 'tests/helpers/developmentActionWorkspace'])
  })
})

describe('RFC-584 —— Intent 维护用例测生产命令', () => {
  test('rfc234-turn-engine 取 intent composition 的维护命令，不再出现副本的三个函数名', () => {
    const text = readFileSync(join(BACKEND, 'tests', 'rfc234-turn-engine.test.ts'), 'utf8')
    expect(resolvedTargets(join(BACKEND, 'tests', 'rfc234-turn-engine.test.ts'), text)).toContain(
      'src/modules/intent/composition/maintenance',
    )
    for (const name of ['composeIntentMaintenanceCommands(', 'composeLocalIntentScratch('])
      expect([name, text.includes(name)]).toEqual([name, true])
    for (const name of [
      'listIntentTurnIdsForBootRecovery',
      'recoverIntentTurnsOnBoot',
      'sweepIntentScratch',
    ])
      expect([name, text.includes(name)]).toEqual([name, false])
  })
})
