// RFC-586 — 合并冲突解决的纯逻辑归 source-control 的 domain（RFC-294 W5 余项第二步）。
//
// 为什么存在：`services/mergeAgent.ts` 原样迁入 `modules/source-control/domain/mergeConflictResolution.ts`，`residualConflictMarkers` 随同从 `util/git`
// 移入；合并代理的三个模板函数经 source-control 的 `public/participants` 交给 task-execution 的合并冲突端口。锁四件事：
// ① 旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它（判据带负对照）。
// ② 新的 domain 文件只取 shared 与本模块 domain（判据带负对照）。
// ③ `residualConflictMarkers` 在 backend `src` 里只声明一次，就在这个 domain 文件里。
// ④ task-execution 的合并冲突装配经 source-control 的 public 取模板函数，取到的与 domain 里的是同一份。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② 只读新文件；③ 读 backend `src`；④ 读
// task-execution 的那个装配文件并在运行时比对函数身份。合并代理、冲突解析与判定的行为由 `rfc130-merge-agent`、`rfc130-iso-worktree-primitives`、
// `rfc130-merge-resolve` 与 `rfc282-b2-resolve-injection` 覆盖。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import * as domain from '@/modules/source-control/domain/mergeConflictResolution'
import * as participants from '@/modules/source-control/public/participants'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const SC = 'modules/source-control'
const slash = (path: string) => path.split('\\').join('/')
const NEW = `${SC}/domain/mergeConflictResolution`

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

/** Specifiers of the domain file that break ②: shared and this module's domain only. */
function domainLeaks(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text
      const inDomain =
        specifier.startsWith('.') &&
        slash(relative(SRC, resolve(dirname(join(SRC, path)), specifier))).startsWith(
          `${SC}/domain/`,
        )
      if (specifier !== '@agent-workflow/shared' && !inDomain) out.push(specifier)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

describe('RFC-586 —— mergeAgent 离开 services/', () => {
  test('旧路径不存在，新路径存在', () => {
    expect(existsSync(join(SRC, 'services', 'mergeAgent.ts'))).toBe(false)
    expect(existsSync(join(SRC, `${NEW}.ts`))).toBe(true)
  })

  // RFC-629: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.

  test('负对照：别名、相对路径、带扩展名、动态 import 与 import 类型都会被认出；新位置不算', () => {
    expect(
      resolvedTargets(
        join(BACKEND, 'tests', 'probe.test.ts'),
        "import { buildMergeAgent } from '@/services/mergeAgent'\n" +
          "import { parseConflictManifest } from '../src/services/mergeAgent.ts'\n" +
          "const m = await import('../src/services/mergeAgent')\n" +
          "export type Probe = typeof import('@/services/mergeAgent')\n" +
          `import { evaluateResolution } from '@/${NEW}'\n`,
      ).filter((target) => target === 'src/services/mergeAgent'),
    ).toEqual([
      'src/services/mergeAgent',
      'src/services/mergeAgent',
      'src/services/mergeAgent',
      'src/services/mergeAgent',
    ])
  })
})

describe('RFC-586 —— domain 文件只取 shared 与本模块 domain', () => {
  test('新文件的 import 只有 shared 与同目录的声明', () => {
    expect(domainLeaks(`${NEW}.ts`, readFileSync(join(SRC, `${NEW}.ts`), 'utf8'))).toEqual([])
  })

  test('负对照：git 模块、本模块 public / infrastructure 与 legacy 都会被认出', () => {
    expect(
      domainLeaks(
        `${NEW}.ts`,
        "import { envelopeOpenTag } from '@agent-workflow/shared'\n" +
          "import type { MergeConflictEntry } from './isolationConflict'\n" +
          "import { residualConflictMarkers } from '@/util/git'\n" +
          "import type { MergeConflictManifest } from '@/modules/source-control/public/types'\n" +
          "import { runGit } from '../infrastructure/local/nodeIsolation'\n" +
          "export type { X } from '@/services/x'\n",
      ),
    ).toEqual([
      '@/util/git',
      '@/modules/source-control/public/types',
      '../infrastructure/local/nodeIsolation',
      '@/services/x',
    ])
  })
})

describe('RFC-586 —— 冲突标记判定与模板函数', () => {
  test('residualConflictMarkers 只在新文件声明一次', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThanOrEqual(1500)
    const declaring = files.filter((path) =>
      /\bfunction residualConflictMarkers\b/.test(readFileSync(path, 'utf8')),
    )
    expect(declaring.map((path) => slash(relative(SRC, path)))).toEqual([`${NEW}.ts`])
  }, 120_000)

  test('task-execution 的合并冲突装配经 source-control 的 public 取三个模板函数，与 domain 里的是同一份', () => {
    const path = join(SRC, 'modules', 'task-execution', 'composition', 'mergeConflictResolution.ts')
    const targets = resolvedTargets(path, readFileSync(path, 'utf8'))
    expect(targets).toContain(`src/${SC}/public/participants`)
    expect(
      targets.filter(
        (target) => target.startsWith(`src/${SC}/`) && !target.startsWith(`src/${SC}/public/`),
      ),
    ).toEqual([])
    expect(participants.buildMergeAgent).toBe(domain.buildMergeAgent)
    expect(participants.buildMergeResolvePrompt).toBe(domain.buildMergeResolvePrompt)
    expect(participants.mergeResolveNodeId).toBe(domain.mergeResolveNodeId)
  })
})
