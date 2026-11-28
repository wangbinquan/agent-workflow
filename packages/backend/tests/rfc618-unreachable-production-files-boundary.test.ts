// RFC-618 — 四个不可达生产文件出生产树（RFC-294 S11 余项：`unreachable-production-files` 8 → 4）。
//
// 为什么存在：这四个文件在生产树里，但生产入口一个都走不到（架构报告的 `unreachable-production-files`）：
// - Intent 的平台 / 意图字段对账表（RFC-348）是测试数据，只有两条用例取它——原样迁入 `tests/helpers/intentTeachingReconciliation.ts`；
// - resource-catalog 的 portable-import 引用一对（application 与 composition）写成起就没有消费方，生产的 portable import 走
//   `application/agents/importPorts.ts` 与 `infrastructure/agentImportQueries.ts`——删除；
// - resource-catalog 的 `legacy/workflow.yaml.ts`（YAML 预览与选择子投影）在 RFC-271 下线单文件 YAML 导出 / 导入后只剩用例在用——删除，
//   只测它的四条用例随之删去（RFC-264 的命名折叠由创建边界与 `CreateWorkflowSchema` 的用例覆盖，RFC-243 的 id 缓存剥离由 shared 选择子的用例覆盖）。
// 锁四件事：
// ① 四个旧位置不在，测试数据在 `tests/helpers/`。
// ② backend 的 `src`、`tests`、`scripts` 与仓库根的 `scripts`、`tests` 里没有文件再经任何写法（别名、相对路径、动态 import、`mock.module`、
//    `require`）取四个旧位置（语料下限 3,000）。
// ③ 生产树不取迁入 `tests/helpers/` 的对账表。
// ④ 退役的四个函数（portable-import 的两个装配与应用工厂、YAML 预览、选择子投影）不在生产树里换个地方重新声明。
// 每一条都带负对照（伪造源码）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'
import ts from 'typescript'

import { RFC618_REMOVED as REMOVED } from './helpers/rfc624MigrationReferenceRules'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const HELPER = join(BACKEND, 'tests', 'helpers', 'intentTeachingReconciliation.ts')
const RETIRED_FUNCTIONS = [
  'composePortableImportReferences',
  'composePortableImportReferencesInTransaction',
  'createPortableImportReferenceApplication',
  'previewWorkflowYaml',
  'workflowDefinitionToSelectors',
] as const

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

/** The absolute target of a specifier without its extension, or null for a package. */
function target(path: string, specifier: string): string | null {
  const resolved = specifier.startsWith('@/')
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? normalize(join(dirname(path), specifier))
      : null
  return resolved === null ? null : resolved.replace(/\.(?:ts|js|mjs)$/, '')
}

/** Specifiers of a file that resolve to one of the removed production paths. */
function removedImports(path: string, text: string): string[] {
  return specifiers(path, text).filter((specifier) => {
    const resolved = target(path, specifier)
    if (resolved === null) return false
    const rel = relative(SRC, resolved).replaceAll('\\', '/')
    return (REMOVED as readonly string[]).includes(rel)
  })
}

/** Specifiers of a production file that reach the reconciliation helper under tests/. */
function helperImports(path: string, text: string): string[] {
  if (
    !text.includes('intentTeachingReconciliation') &&
    !text.includes('\\u') &&
    !text.includes('\\x')
  )
    return []
  return specifiers(path, text).filter(
    (specifier) => target(path, specifier) === HELPER.replace(/\.ts$/, ''),
  )
}

/** Names of the retired functions a file declares (function, variable or export alias). */
function retiredDeclarations(path: string, text: string): string[] {
  if (!RETIRED_FUNCTIONS.some((name) => text.includes(name)) && !text.includes('\\u')) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const name =
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
        ? node.name.text
        : ts.isExportSpecifier(node)
          ? node.name.text
          : null
    if (name !== null && (RETIRED_FUNCTIONS as readonly string[]).includes(name)) found.push(name)
    node.forEachChild(visit)
  }
  visit(source)
  return found
}

describe('RFC-618 —— 四个不可达生产文件出生产树', () => {
  test('四个旧位置不在，测试数据在 tests/helpers/', () => {
    for (const removed of REMOVED)
      expect([removed, existsSync(join(SRC, `${removed}.ts`))]).toEqual([removed, false])
    expect(existsSync(HELPER)).toBe(true)
  })

  // RFC-629: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.

  test('生产树不取迁入 tests/helpers/ 的对账表，也不重新声明退役的函数', () => {
    const production = walk(SRC)
    expect(production.length).toBeGreaterThanOrEqual(1500)
    const found = production.flatMap((path) => {
      const text = readFileSync(path, 'utf8')
      return [
        ...helperImports(path, text).map(
          (specifier) => `${relative(BACKEND, path)} -> ${specifier}`,
        ),
        ...retiredDeclarations(path, text).map(
          (name) => `${relative(BACKEND, path)} declares ${name}`,
        ),
      ]
    })
    expect(found).toEqual([])
  }, 60_000)
})

describe('RFC-618 —— 负对照（伪造源码）', () => {
  test('判据认得出别名、相对路径与 mock.module 三种写法，字符串里的路径不算', () => {
    const fromTests = join(BACKEND, 'tests', 'probe.test.ts')
    expect(
      removedImports(
        fromTests,
        [
          "import { schemaKeys } from '../src/modules/intent/domain/teaching/reconciliation'",
          "import { previewWorkflowYaml } from '@/modules/resource-catalog/infrastructure/legacy/workflow.yaml'",
          "mock.module('@/modules/resource-catalog/composition/portableImportReferences', () => ({}))",
          'const quoted = "import x from \'@/modules/resource-catalog/application/portableImportReferences\'"',
          "import { getWorkflow } from '@/modules/resource-catalog/infrastructure/legacy/workflow'",
        ].join('\n'),
      ),
    ).toEqual([
      '../src/modules/intent/domain/teaching/reconciliation',
      '@/modules/resource-catalog/infrastructure/legacy/workflow.yaml',
      '@/modules/resource-catalog/composition/portableImportReferences',
    ])
  })

  test('判据认得出生产文件取测试数据、重新声明退役函数', () => {
    const fromSrc = join(SRC, 'modules', 'intent', 'domain', 'teaching', 'probe.ts')
    expect(
      helperImports(
        fromSrc,
        "import { schemaKeys } from '../../../../../tests/helpers/intentTeachingReconciliation'\n",
      ),
    ).toEqual(['../../../../../tests/helpers/intentTeachingReconciliation'])
    expect(
      retiredDeclarations(
        fromSrc,
        [
          'export function previewWorkflowYaml() {}',
          'export const composePortableImportReferences = () => undefined',
          'const workflowDefinitionToSelectorsLater = 1',
          'export { local as workflowDefinitionToSelectors }',
        ].join('\n'),
      ),
    ).toEqual([
      'previewWorkflowYaml',
      'composePortableImportReferences',
      'workflowDefinitionToSelectors',
    ])
  })
})
