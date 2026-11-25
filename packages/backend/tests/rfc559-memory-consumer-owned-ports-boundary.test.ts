// RFC-559 — task-execution 与 collaboration 不再取 memory 的 public：记忆注入与蒸馏入队改为 consumer 自有端口（RFC-294 S9 第十四步）。
//
// 锁四件事：
// ① task-execution 与 collaboration 的生产文件不取 memory 的任何文件（目标 DAG 只有 memory → 它们的 offered 边；判据带负对照）。
// ② 三个端口在各自的 `application/ports`，只取 shared 合同。
// ③ 编译期断言：memory 的注入查询与蒸馏命令可以赋给这三个端口（bootstrap 交的就是它们）。
// ④ 失去最后一个外部消费方的 `ScopeBudget` 撤出了 memory 的 `public/types`。
//
// 覆盖范围（C12）：① 覆盖两个 context 的全部源码；② ④ 只读点名的文件；③ 由 `tsc` 检查。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import type { CollaborationMemoryDistillPort } from '../src/modules/collaboration/application/ports/taskFeedbackMemoryDistill'
import type { MemoryDistillEnqueuer } from '../src/modules/memory/public/participants'
import type { MemoryInjectionQueries } from '@/modules/memory/application/memoryOperationContracts'
import type { TaskMemoryDistillPort } from '../src/modules/task-execution/application/ports/taskMemoryDistill'
import type { TaskMemoryInjectionPort } from '../src/modules/task-execution/application/ports/taskMemoryInjection'

const SRC = resolve(import.meta.dir, '..', 'src')
const MODULES = join(SRC, 'modules')
const read = (path: string) => readFileSync(join(MODULES, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Module specifiers of imports and re-exports, resolved to `src/`-relative paths when they point into the backend. */
function specifierTargets(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const add = (specifier: string) => {
    const target = specifier.startsWith('@/')
      ? join(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(dirname(path), specifier)
        : null
    out.push(target === null ? specifier : slash(relative(SRC, target)))
  }
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    )
      add(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

const memoryTargets = (path: string, text: string) =>
  specifierTargets(path, text).filter((target) => target.startsWith('modules/memory/'))

// Compile-time: the memory objects the assembly root hands over satisfy the consumer-owned ports.
const injection = (queries: MemoryInjectionQueries): TaskMemoryInjectionPort => queries
const taskDistill = (commands: MemoryDistillEnqueuer): TaskMemoryDistillPort => commands
const feedbackDistill = (commands: MemoryDistillEnqueuer): CollaborationMemoryDistillPort =>
  commands

describe('RFC-559 —— task-execution 与 collaboration 不取 memory', () => {
  test('两个 context 的全部源码里没有指向 memory 的 import / 转出 / 动态 import', () => {
    const files = [
      ...walk(join(MODULES, 'task-execution')),
      ...walk(join(MODULES, 'collaboration')),
    ]
    expect(files.length).toBeGreaterThanOrEqual(900)
    const found = files.flatMap((path) =>
      memoryTargets(path, readFileSync(path, 'utf8')).map(
        (target) => `${slash(relative(MODULES, path))} -> ${target}`,
      ),
    )
    expect(found).toEqual([])
  }, 60_000)

  test('负对照：public、内部文件、相对路径与动态 import 都会被认出，别的 context 不算', () => {
    const at = join(MODULES, 'task-execution', 'application', 'probe.ts')
    expect(
      memoryTargets(
        at,
        "import type { A } from '@/modules/memory/public/queries'\n" +
          "export type { B } from '../../memory/domain/injectionRendering'\n" +
          "const c = () => import('@/modules/memory/composition')\n" +
          "import type { D } from '@/modules/source-control/public/types'\n" +
          "import type { E } from '@agent-workflow/shared'\n",
      ),
    ).toEqual([
      'modules/memory/public/queries',
      'modules/memory/domain/injectionRendering',
      'modules/memory/composition',
    ])
  })
})

describe('RFC-559 —— 三个 consumer 自有端口', () => {
  test('端口在各自的 application/ports，只取 shared 合同', () => {
    for (const path of [
      'task-execution/application/ports/taskMemoryInjection.ts',
      'task-execution/application/ports/taskMemoryDistill.ts',
      'collaboration/application/ports/taskFeedbackMemoryDistill.ts',
    ]) {
      const targets = specifierTargets(join(MODULES, path), read(path))
      expect(targets.filter((target) => target !== '@agent-workflow/shared')).toEqual([])
    }
  })

  test('memory 的对象满足这三个端口（编译期由 tsc 检查，这里留运行期锚点）', () => {
    for (const bind of [injection, taskDistill, feedbackDistill])
      expect(typeof bind).toBe('function')
  })
})

describe('RFC-559 —— 失去消费方的 memory public 符号撤出', () => {
  test('memory 的 public/types 不再交出 ScopeBudget', () => {
    const path = join(MODULES, 'memory/public/types.ts')
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    // RFC-578 withdrew the file's last `export { … } from` (the candidate predicate); it now offers only declarations,
    // so both forms are read — ScopeBudget may come back as either.
    const exported = source.statements.flatMap((statement) => {
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause)
      )
        return statement.exportClause.elements.map((element) => element.name.text)
      const isExported =
        ts.canHaveModifiers(statement) &&
        (ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
          false)
      return isExported &&
        (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
        ? [statement.name.text]
        : []
    })
    expect(exported.length).toBeGreaterThan(0)
    expect(exported).not.toContain('ScopeBudget')
  })
})
