// RFC-562 — 托管对象发布日志归内容 owner（platform/content），恢复归一参与者是 system-operations 的 required 端口（RFC-294 S9 第十七步）。
//
// 锁五件事：
// ① 业务模块取 system-operations 的，只剩 task-execution 的指定 adapter 按类型取 `composition/required-ports`（判据带负对照）。
// ② 发布日志的合同与实现在 platform/content，旧位置不存在；合同只取类型，实现不取任何 `modules/`；system-operations 的 public 不再交出
//    它们，也不再交出恢复归一参与者。
// ③ 恢复归一参与者声明在 system-operations 的 `application/ports`、经 required-ports 交出；task-execution 的 adapter 按类型转出，实现从
//    adapter 取；bootstrap 从 required-ports 取类型、从 task-execution 的装配根取实现（不再经 task-execution 的 public）。
// ④ system-operations 自己的恢复归一不再直接碰 `content_publications`，改调日志的闭合操作。
// ⑤ 目标 DAG 登记了这条虚线 required 边（`rfc294-design-parity` 另锁它与 RFC-294 design 的 Mermaid 一致）。
//
// 覆盖范围（C12）：① 覆盖 system-operations 以外全部模块的源码；② ③ ④ ⑤ 只读点名的文件与常量。行为由
// `rfc562-restore-publication-release` 与既有的 `rfc370-*` 用例覆盖。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { REQUIRED_CONTEXT_EDGES } from './architecture/rfc294Target'

const SRC = resolve(import.meta.dir, '..', 'src')
const MODULES = join(SRC, 'modules')
const OWNER = 'system-operations'
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

interface ModuleSpecifier {
  readonly text: string
  readonly typeOnly: boolean
}

/** Module specifiers of imports, re-exports, dynamic imports and `import('…')` types, each with whether it is type-only. */
function moduleSpecifiers(path: string, text: string): ModuleSpecifier[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: ModuleSpecifier[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      out.push({
        text: node.moduleSpecifier.text,
        typeOnly:
          clause?.isTypeOnly === true ||
          (clause !== undefined &&
            clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)),
      })
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      out.push({ text: node.moduleSpecifier.text, typeOnly: node.isTypeOnly })
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    )
      out.push({ text: node.arguments[0].text, typeOnly: false })
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      out.push({ text: node.argument.literal.text, typeOnly: true })
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** Edges from a file into system-operations, as `<rest> (<type|value>)`. */
function ownerEdges(path: string, text: string): string[] {
  return moduleSpecifiers(path, text).flatMap((specifier) => {
    const target = specifier.text.startsWith('@/')
      ? join(SRC, specifier.text.slice(2))
      : specifier.text.startsWith('.')
        ? resolve(dirname(path), specifier.text)
        : null
    if (target === null) return []
    const rest = new RegExp(`^${OWNER}/(.+)$`).exec(slash(relative(MODULES, target)))?.[1]
    return rest === undefined ? [] : [`${rest} (${specifier.typeOnly ? 'type' : 'value'})`]
  })
}

describe('RFC-562 —— 业务模块只经指定 adapter 取 system-operations', () => {
  test('别的模块全部源码里，只剩 task-execution 的 adapter 按类型取 required-ports', () => {
    const files = readdirSync(MODULES)
      .filter((name) => name !== OWNER)
      .flatMap((name) => walk(join(MODULES, name)))
    expect(files.length).toBeGreaterThanOrEqual(2400)
    const found = [
      ...new Set(
        files.flatMap((path) =>
          ownerEdges(path, readFileSync(path, 'utf8')).map(
            (edge) => `${slash(relative(MODULES, path))} -> ${edge}`,
          ),
        ),
      ),
    ].sort()
    expect(found).toEqual([
      'task-execution/application/adapters/system-operations-adapter.ts -> composition/required-ports (type)',
    ])
  }, 120_000)

  test('负对照：public、内部文件、值导入、转出、相对路径与动态 import 都会被认出，别的 context 与平台不算', () => {
    const at = join(MODULES, 'task-execution', 'infrastructure', 'crewstation', 'probe.ts')
    expect(
      ownerEdges(
        at,
        "import type { A } from '@/modules/system-operations/public/participants'\n" +
          "import { b } from '@/modules/system-operations/composition/crewstationObjectPublications'\n" +
          "export type { C } from '../../../system-operations/application/ports/hostedRestoreNormalization'\n" +
          "const d = () => import('@/modules/system-operations/public/commands')\n" +
          "import { type E } from '@/modules/system-operations/composition/required-ports'\n" +
          "type H = import('@/modules/system-operations/public/types').RestorePlanView\n" +
          "import type { F } from '@/platform/content/hostedObjectPublications'\n" +
          "import type { G } from '@/modules/source-control/public/participants'\n",
      ),
    ).toEqual([
      'public/participants (type)',
      'composition/crewstationObjectPublications (value)',
      'application/ports/hostedRestoreNormalization (type)',
      'public/commands (value)',
      'composition/required-ports (type)',
      'public/types (type)',
    ])
  })
})

describe('RFC-562 —— 发布日志归 platform/content', () => {
  test('合同与实现在 platform/content，旧位置不存在', () => {
    for (const path of [
      'modules/system-operations/infrastructure/crewstation/objectPublicationContract.ts',
      'modules/system-operations/infrastructure/crewstation/objectPublications.ts',
      'modules/system-operations/infrastructure/crewstation/restoreNormalizationContract.ts',
    ])
      expect([path, existsSync(join(SRC, path))]).toEqual([path, false])
    const contract = 'platform/content/hostedObjectPublications.ts'
    expect(read(contract)).toContain('export interface HostedObjectPublications {')
    const contractSpecifiers = moduleSpecifiers(join(SRC, contract), read(contract))
    expect(contractSpecifiers.length).toBeGreaterThan(0)
    expect(contractSpecifiers.every((specifier) => specifier.typeOnly)).toBe(true)
    const journal = 'platform/content/infrastructure/hostedObjectPublications.ts'
    expect(read(journal)).toContain('export function createHostedObjectPublications(')
    const journalSpecifiers = moduleSpecifiers(join(SRC, journal), read(journal))
    expect(journalSpecifiers.length).toBeGreaterThan(0)
    expect(
      journalSpecifiers
        .map((specifier) => specifier.text)
        .filter((text) => /(?:^|\/)modules\//.test(text) || text.startsWith('@/services/')),
    ).toEqual([])
  })

  test('system-operations 的 public 不再交出发布日志的类型与恢复归一参与者', () => {
    for (const path of [
      'modules/system-operations/public/participants.ts',
      'modules/system-operations/public/commands.ts',
    ]) {
      const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
      const exported = source.statements.flatMap((statement) =>
        ts.isExportDeclaration(statement) &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements.map((element) => element.name.text)
          : ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
            ? [statement.name.text]
            : [],
      )
      expect(exported.length).toBeGreaterThan(0)
      expect(
        exported.filter((name) => /^Hosted(?:Object|RestoreNormalization)/.test(name)),
      ).toEqual([])
    }
  })

  test('装配与备份从平台取发布日志；恢复归一改调日志的闭合操作，不再直接碰 content_publications', () => {
    expect(
      read('modules/system-operations/composition/crewstationObjectPublications.ts'),
    ).toContain(
      "import { createHostedObjectPublications } from '@/platform/content/infrastructure/hostedObjectPublications'",
    )
    const normalization = read(
      'modules/system-operations/infrastructure/crewstation/hostedRestoreNormalization.ts',
    )
    expect(normalization).toContain('await releaseHostedPublicationsInTx(tx, {')
    expect(normalization).toContain('await adoptHostedPublicationInTx(tx, {')
    expect(normalization).not.toContain('contentPublications')
    expect(read('platform/content/infrastructure/hostedObjectPublications.ts')).toContain(
      'export async function releaseHostedPublicationsInTx(',
    )
  })
})

describe('RFC-562 —— 恢复归一参与者是 system-operations 的 required 端口', () => {
  test('声明在 application/ports，经 required-ports 交出；adapter 按类型转出，实现与 bootstrap 各从该取的地方取', () => {
    expect(
      read('modules/system-operations/application/ports/hostedRestoreNormalization.ts'),
    ).toContain('export interface HostedRestoreNormalizationParticipant {')
    expect(read('modules/system-operations/composition/required-ports.ts')).toContain(
      "export type { HostedRestoreNormalizationParticipant } from '../application/ports/hostedRestoreNormalization'",
    )
    expect(
      read('modules/task-execution/application/adapters/system-operations-adapter.ts'),
    ).toContain(
      "export type { HostedRestoreNormalizationParticipant } from '@/modules/system-operations/composition/required-ports'",
    )
    expect(read('modules/task-execution/infrastructure/hostedRestoreNormalization.ts')).toContain(
      "import type { HostedRestoreNormalizationParticipant } from '../application/adapters/system-operations-adapter'",
    )
    expect(read('bootstrap/crewstation.ts')).toContain(
      "import type { HostedRestoreNormalizationParticipant } from '@/modules/system-operations/composition/required-ports'",
    )
  })

  test('task-execution 的实现由装配根交给 bootstrap，不再从 public 交出', () => {
    expect(read('modules/task-execution/composition.ts')).toContain(
      "export { createHostedRestoreTaskNormalization } from './infrastructure/hostedRestoreNormalization'",
    )
    const participants = read('modules/task-execution/public/participants.ts')
    expect(participants.length).toBeGreaterThan(0)
    expect(participants).not.toContain('createHostedRestoreTaskNormalization')
    expect(read('bootstrap/crewstation.ts')).toContain(
      "import { createHostedRestoreTaskNormalization } from '@/modules/task-execution/composition'",
    )
  })

  test('目标 DAG 登记了 task-execution implements HostedRestoreNormalizationParticipant → system-operations', () => {
    expect(REQUIRED_CONTEXT_EDGES).toContainEqual([
      'task-execution',
      'system-operations',
      'HostedRestoreNormalizationParticipant',
    ])
  })
})
