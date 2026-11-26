// RFC-617 — util/ 的六个通用原语原样归 platform（RFC-294 W9-D 余项：`util/` 中的通用原语归 `platform/`，design §2.2）。
//
// 为什么存在：`util/` 是横向目录（`legacy-horizontal-files` 计数），六个模块与 platform 自己都直接取它。六个文件原样迁入 platform——
// `redact` → `platform/logging/`，`safePath` → `platform/workspace/local/`，`fileTrust`、`win32Acl`、`gitHardening` → `platform/execution/local/`
// （git 运行器 RFC-591 起就在那里，加固参数是它的环境策略），`gitRef` → `platform/contracts/`（纯函数，development-automation、
// digital-employee、source-control 都在用）——读者一次改指，旧位置不留转出。只改了两条模块内相对路径与一处注释，没有任何逻辑改动。锁三件事：
// ① 旧位置不在、新位置在；backend 的 `src`、`tests`、`scripts` 与仓库根的 `scripts`、`tests`（性能基准）里没有文件再经任何写法（别名、相对路径、
//    动态 import、`mock.module`、`require`）取旧位置（语料下限 3,000）。
// ② 六个新文件只取 node 内置、shared 与 platform，不取任何模块或 legacy 目录。
// ③ 负对照：判据认得出别名、相对路径与 `mock.module` 三种写法。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const MOVED: readonly (readonly [string, string])[] = [
  ['util/redact', 'platform/logging/redact'],
  ['util/safePath', 'platform/workspace/local/safePath'],
  ['util/fileTrust', 'platform/execution/local/fileTrust'],
  ['util/win32Acl', 'platform/execution/local/win32Acl'],
  ['util/gitRef', 'platform/contracts/gitRef'],
  ['util/gitHardening', 'platform/execution/local/gitHardening'],
]
const OLD = new Set(MOVED.map(([old]) => old))

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.(?:[cm]?ts|mjs)$/.test(name) ? [path] : []
  })
}

/**
 * Every module specifier a file names on the syntax tree — imports, re-exports, `import('…')`, `require('…')` and
 * `mock.module('…')` — so specifiers quoted inside other strings (negative fixtures) never count.
 */
function specifiers(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      out.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression.getText(source)
      const first = node.arguments[0]!
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          callee === 'require' ||
          callee === 'mock.module') &&
        ts.isStringLiteralLike(first)
      )
        out.push(first.text)
    }
    node.forEachChild(visit)
  }
  visit(source)
  return out
}

/** Specifiers of a file that resolve to one of the old util paths. */
function oldUtilImports(path: string, text: string): string[] {
  const found: string[] = []
  for (const specifier of specifiers(path, text)) {
    const target = specifier.startsWith('@/')
      ? join(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? normalize(join(dirname(path), specifier))
        : null
    if (target === null) continue
    const rel = relative(SRC, target)
      .replaceAll('\\', '/')
      .replace(/\.(?:ts|js|mjs)$/, '')
    if (OLD.has(rel)) found.push(specifier)
  }
  return found
}

/** Specifiers of a moved file that leave node built-ins, shared and platform. */
function foreignImports(path: string, text: string): string[] {
  const found: string[] = []
  for (const specifier of specifiers(path, text)) {
    if (specifier.startsWith('node:') || specifier === '@agent-workflow/shared') continue
    if (specifier.startsWith('@/platform/')) continue
    if (specifier.startsWith('.')) {
      const target = relative(SRC, normalize(join(dirname(path), specifier))).replaceAll('\\', '/')
      if (target.startsWith('platform/')) continue
    }
    found.push(specifier)
  }
  return found
}

describe('RFC-617 —— util/ 的六个通用原语原样归 platform', () => {
  test('旧位置不在、新位置在', () => {
    for (const [old, next] of MOVED) {
      expect([old, existsSync(join(SRC, `${old}.ts`))]).toEqual([old, false])
      expect([next, existsSync(join(SRC, `${next}.ts`))]).toEqual([next, true])
    }
  })

  test('没有文件再经任何写法取旧位置', () => {
    const files = [
      ...walk(SRC),
      ...walk(join(BACKEND, 'tests')),
      ...walk(join(BACKEND, 'scripts')),
      ...walk(resolve(BACKEND, '../../scripts')),
      ...walk(resolve(BACKEND, '../../tests')),
    ]
    expect(files.length).toBeGreaterThanOrEqual(3000)
    const leaks = files.flatMap((path) =>
      oldUtilImports(path, readFileSync(path, 'utf8')).map(
        (specifier) => `${relative(BACKEND, path)} -> ${specifier}`,
      ),
    )
    expect(leaks).toEqual([])
  }, 60_000)

  test('六个新文件只取 node 内置、shared 与 platform', () => {
    for (const [, next] of MOVED) {
      const path = join(SRC, `${next}.ts`)
      expect([next, foreignImports(path, readFileSync(path, 'utf8'))]).toEqual([next, []])
    }
  })
})

describe('RFC-617 —— 负对照（伪造源码）', () => {
  test('判据认得出别名、相对路径与 mock.module 三种写法', () => {
    const fromTests = join(BACKEND, 'tests', 'probe.test.ts')
    expect(
      oldUtilImports(
        fromTests,
        [
          "import { redactSensitiveString } from '@/util/redact'",
          "import { safeJoin } from '../src/util/safePath'",
          "mock.module('@/util/gitHardening', () => ({}))",
          "import { hash } from '@/platform/contracts/hash'",
        ].join('\n'),
      ),
    ).toEqual(['@/util/redact', '../src/util/safePath', '@/util/gitHardening'])
    expect(
      foreignImports(
        join(SRC, 'platform', 'logging', 'probe.ts'),
        "import { x } from '@/modules/task-execution/public/types'\nimport { y } from '../../util/gitCredentialLease'\n",
      ),
    ).toEqual(['@/modules/task-execution/public/types', '../../util/gitCredentialLease'])
  })
})
