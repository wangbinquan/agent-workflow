// RFC-620 — 静态加密盒归 platform：合同进 `platform/contracts`，实现进 `platform/crypto`（RFC-294 W9-D 余项）。
//
// 为什么存在：`auth/secretBox.ts` 是四个模块与 bootstrap 共用的 AES-256-GCM 静态加密盒，只取 node 内置。它拆成两份——`SecretBox` 接口进
// `platform/contracts/secretBox.ts`（中性合同，application 只许取 `platform/contracts`），密钥文件与加解密实现原样进 `platform/crypto/secretBox.ts`
// （取合同里的类型，不转出它）。读者一次改指：只取类型的取合同，取实现的取 `platform/crypto`，混合 import 拆成两条；旧位置不留转出。锁四件事：
// ① 旧位置不在，两个新文件在；合同只声明接口、不 import 任何东西；实现只取 node 内置与合同。
// ② backend 的 `src`、`tests`、`scripts` 与仓库根的 `scripts`、`tests` 里没有文件再经任何写法取旧位置（语料下限 3,000）。
// ③ 模块的 application 层不取 `platform/crypto/secretBox`；没有文件从 `platform/crypto/secretBox` 取 `SecretBox` 类型（类型一律取合同）。
// ④ 负对照（伪造源码）：别名、相对路径与 `mock.module` 都认得出，字符串里的路径不算；application 取实现、从实现取类型都认得出。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const OLD = 'auth/secretBox'
const CONTRACT = 'platform/contracts/secretBox'
const IMPL = 'platform/crypto/secretBox'

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.(?:[cm]?ts|mjs)$/.test(name) ? [path] : []
  })
}

interface ImportSite {
  readonly specifier: string
  /** Names this import binds, with whether each is type-only (`import type` or an inline `type` modifier). */
  readonly names: readonly { readonly name: string; readonly typeOnly: boolean }[]
}

/**
 * Every module specifier a file names on the syntax tree — imports, re-exports, `import('…')`, `require('…')` and
 * `mock.module('…')` — so specifiers quoted inside other strings (negative fixtures) never count.
 */
function importSites(path: string, text: string): ImportSite[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: ImportSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const names =
        bindings !== undefined && ts.isNamedImports(bindings)
          ? bindings.elements.map((element) => ({
              name: (element.propertyName ?? element.name).text,
              typeOnly: clause!.isTypeOnly || element.isTypeOnly,
            }))
          : []
      out.push({ specifier: node.moduleSpecifier.text, names })
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      out.push({ specifier: node.moduleSpecifier.text, names: [] })
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

/** The path below `src` a specifier resolves to, without its extension, or null for a package. */
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

/** Specifiers of a file that reach the old location. */
function oldImports(path: string, text: string): string[] {
  return importSites(path, text)
    .filter((site) => targetOf(path, site.specifier) === OLD)
    .map((site) => site.specifier)
}

/** Findings for a production file: application files taking the implementation, and any file taking the type from it. */
function layerFindings(path: string, text: string): string[] {
  const rel = relative(SRC, path).replaceAll('\\', '/')
  const application = /^modules\/[^/]+\/application\//.test(rel)
  return importSites(path, text).flatMap((site) => {
    if (targetOf(path, site.specifier) !== IMPL) return []
    const found: string[] = []
    if (application) found.push(`${rel} (application) -> ${site.specifier}`)
    for (const name of site.names)
      if (name.name === 'SecretBox') found.push(`${rel} takes SecretBox from ${site.specifier}`)
    return found
  })
}

describe('RFC-620 —— 静态加密盒归 platform', () => {
  test('旧位置不在，合同只声明接口，实现只取 node 内置与合同', () => {
    expect(existsSync(join(SRC, `${OLD}.ts`))).toBe(false)
    const contractPath = join(SRC, `${CONTRACT}.ts`)
    const implPath = join(SRC, `${IMPL}.ts`)
    const contract = readFileSync(contractPath, 'utf8')
    expect(importSites(contractPath, contract)).toEqual([])
    expect(contract).toContain('export interface SecretBox {')
    const impl = readFileSync(implPath, 'utf8')
    expect(
      importSites(implPath, impl)
        .map((site) => site.specifier)
        .filter(
          (specifier) =>
            !specifier.startsWith('node:') && targetOf(implPath, specifier) !== CONTRACT,
        ),
    ).toEqual([])
    expect(impl).not.toContain('export interface SecretBox')
    for (const name of [
      'export function ensureSecretKey(',
      'export function createSecretBox(',
      'export function createSecretBoxFromKey(',
    ])
      expect([name, impl.includes(name)]).toEqual([name, true])
  })

  test('没有文件再经任何写法取旧位置', () => {
    const files = [
      ...walk(SRC),
      ...walk(join(BACKEND, 'tests')),
      ...walk(join(BACKEND, 'scripts')),
      ...walk(join(REPO, 'scripts')),
      ...walk(join(REPO, 'tests')),
    ]
    expect(files.length).toBeGreaterThanOrEqual(3000)
    const leaks = files.flatMap((path) =>
      oldImports(path, readFileSync(path, 'utf8')).map(
        (specifier) => `${relative(BACKEND, path)} -> ${specifier}`,
      ),
    )
    expect(leaks).toEqual([])
  }, 60_000)

  test('application 不取实现，类型一律取合同', () => {
    const production = walk(SRC)
    expect(production.length).toBeGreaterThanOrEqual(1500)
    expect(production.flatMap((path) => layerFindings(path, readFileSync(path, 'utf8')))).toEqual(
      [],
    )
  }, 60_000)
})

describe('RFC-620 —— 负对照（伪造源码）', () => {
  test('判据认得出别名、相对路径与 mock.module，字符串里的路径不算', () => {
    expect(
      oldImports(
        join(BACKEND, 'tests', 'probe.test.ts'),
        [
          "import { createSecretBoxFromKey } from '@/auth/secretBox'",
          "import type { SecretBox } from '../src/auth/secretBox'",
          "mock.module('@/auth/secretBox', () => ({}))",
          'const quoted = "import x from \'@/auth/secretBox\'"',
          "import { token } from '@/auth/token'",
        ].join('\n'),
      ),
    ).toEqual(['@/auth/secretBox', '../src/auth/secretBox', '@/auth/secretBox'])
  })

  test('判据认得出 application 取实现、从实现取类型', () => {
    expect(
      layerFindings(
        join(SRC, 'modules', 'integration', 'application', 'probe.ts'),
        "import { createSecretBox, type SecretBox } from '@/platform/crypto/secretBox'\n" +
          "import type { SecretBox as Box } from '@/platform/contracts/secretBox'\n",
      ),
    ).toEqual([
      'modules/integration/application/probe.ts (application) -> @/platform/crypto/secretBox',
      'modules/integration/application/probe.ts takes SecretBox from @/platform/crypto/secretBox',
    ])
    expect(
      layerFindings(
        join(SRC, 'bootstrap', 'probe.ts'),
        "import { createSecretBox } from '@/platform/crypto/secretBox'\n",
      ),
    ).toEqual([])
  })
})
