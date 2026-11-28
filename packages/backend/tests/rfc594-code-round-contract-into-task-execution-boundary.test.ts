// RFC-594 — code-round 的合同叶归 task-execution 的 domain（RFC-294 W9-D：`services/` 余项）。
//
// 为什么存在：RFC-310 删掉 code-round 的写入方之后，`services/codeRoundContract.ts` 只剩一个生产读者——task-execution 的执行结果投影要
// `CODE_ROUND_NODE_ID` 找历史 round 的输出。节点 id 迁入 `modules/task-execution/domain/codeRoundHistory.ts`，只有用例用的快照合成函数迁到
// `tests/helpers/codeRoundHistory.ts`，两个没有读者的导出删除。锁四件事：
// ① 旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它（判据带负对照）。
// ② 生产代码里字符串 `'__code_round__'` 只在 domain 文件里出现一次，执行结果投影从 domain 取（判据带负对照）。
// ③ domain 文件零 import（叶子；判据带负对照）。
// ④ 生产代码里不再声明 `synthesizeCodeRoundSnapshot`、`CODE_ROUND_SUMMARY_PORT`、`StartCodeRoundInput`（判据带负对照）。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② ④ 覆盖 backend `src` 的全部生产文件；
// ③ 只读一个文件。行为由既有用例覆盖（`api-task-output-kind` 的历史 round 投影、`builtin-workflow-auto-layout` 的内置快照布局）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { resolveMigrationSpecifiers } from './helpers/rfc624MigrationSpecifiers'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

const OLD = 'services/codeRoundContract'
const HISTORY = 'modules/task-execution/domain/codeRoundHistory'
const OUTCOME = 'modules/task-execution/infrastructure/executionOutcome'
const NODE_ID = '__code_round__'
const RETIRED = ['CODE_ROUND_SUMMARY_PORT', 'StartCodeRoundInput', 'synthesizeCodeRoundSnapshot']
const read = (file: string) => readFileSync(join(SRC, `${file}.ts`), 'utf8')

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
  return resolveMigrationSpecifiers(SRC, path, text)
}

/** How many string literals (plain and no-substitution template) in a file carry exactly the node id. */
function nodeIdLiterals(path: string, text: string): number {
  if (!text.includes(NODE_ID) && !text.includes('\\u') && !text.includes('\\x')) return 0
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  let count = 0
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && node.text === NODE_ID) count += 1
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

/** Import / export-from specifiers a file names at its top level. */
function topLevelSpecifiers(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  )
}

/** Names a file declares (functions, variables, interfaces, type aliases, classes), exported or not. */
function declaredNames(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) => {
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
}

describe('RFC-594 —— code-round 的合同叶归 task-execution 的 domain', () => {
  test('旧路径不存在，新文件存在', () => {
    // RFC-629: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.
    expect(existsSync(join(SRC, `${OLD}.ts`))).toBe(false)
    expect(existsSync(join(SRC, `${HISTORY}.ts`))).toBe(true)
  })

  test('负对照：别名、相对路径、带扩展名、动态 import 与 import 类型都会被认出；新位置不算', () => {
    expect(
      resolvedSpecifiers(
        join(SRC, 'server.ts'),
        "import { CODE_ROUND_NODE_ID } from '@/services/codeRoundContract'\n" +
          "export { synthesizeCodeRoundSnapshot } from './services/codeRoundContract.ts'\n" +
          "const contract = await import('./services/codeRoundContract')\n" +
          "export type Probe = typeof import('@/services/codeRoundContract')\n" +
          `import { CODE_ROUND_NODE_ID as next } from './${HISTORY}'\n`,
      ).filter((target) => target === OLD),
    ).toEqual([OLD, OLD, OLD, OLD])
  })

  test('生产代码里节点 id 只在 domain 文件里出现一次；执行结果投影从 domain 取', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThanOrEqual(2000)
    expect(
      files.flatMap((path) => {
        const count = nodeIdLiterals(path, readFileSync(path, 'utf8'))
        return count > 0 ? [`${slash(relative(SRC, path))} x${count}`] : []
      }),
    ).toEqual([`${HISTORY}.ts x1`])
    expect(resolvedSpecifiers(join(SRC, `${OUTCOME}.ts`), read(OUTCOME))).toContain(HISTORY)
  })

  test('负对照：普通字符串与无替换的模板字符串都会被数到，注释与更长的字符串不算', () => {
    expect(
      nodeIdLiterals(
        'probe.ts',
        "// the '__code_round__' node\n" +
          "const a = '__code_round__'\n" +
          'const b = `__code_round__`\n' +
          "const c = '__code_round__x'\n",
      ),
    ).toBe(2)
  })

  test('domain 文件零 import；负对照：任何 import 或转出都会被认出', () => {
    expect(topLevelSpecifiers(`${HISTORY}.ts`, read(HISTORY))).toEqual([])
    expect(
      topLevelSpecifiers(
        'probe.ts',
        "import { WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'\n" +
          "export { AGENT_HOST_AGENT_NODE_ID } from './agentHostWorkflow'\n",
      ),
    ).toEqual(['@agent-workflow/shared', './agentHostWorkflow'])
  })

  test('生产代码里不再声明合成函数与两个没有读者的导出；负对照：任一声明都会被认出', () => {
    expect(
      walk(SRC).flatMap((path) => {
        const text = readFileSync(path, 'utf8')
        if (!RETIRED.some((name) => text.includes(name)) && !text.includes('\\u')) return []
        return declaredNames(path, text)
          .filter((name) => RETIRED.includes(name))
          .map((name) => `${slash(relative(SRC, path))}#${name}`)
      }),
    ).toEqual([])
    expect(
      declaredNames(
        'probe.ts',
        "export const CODE_ROUND_SUMMARY_PORT = 'round_summary'\n" +
          'export interface StartCodeRoundInput { roundId: string }\n' +
          "function synthesizeCodeRoundSnapshot(): string { return '' }\n",
      ).filter((name) => RETIRED.includes(name)),
    ).toEqual(RETIRED)
  })
})
