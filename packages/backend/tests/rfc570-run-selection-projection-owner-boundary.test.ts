// RFC-570 — 工作组运行选择投影归 task-execution，source-control 的两个完整性检查收具名类型（RFC-294 S9 第二十五步）。
//
// 为什么存在：`WorkgroupRunSelectionProjection` 是 task-execution 算出的业务投影，原先声明在 `platform/runSelectionProjection.ts`，只为让
// resource-catalog 的房间投影也能取到；task-execution 的 public 合同因此带着一个平台类型。RFC-570 把它搬回 owner 的 domain，resource-catalog 用
// 自己的窄形状声明它读的两个字段，平台文件删除。另把 source-control 两个接收者完整性检查的入参从 `unknown` 改成它们检查的端口类型。锁五件事：
// ① 平台文件不存在，全部生产源码不取它（判据带负对照）。
// ② 投影只在 task-execution 的 domain 声明一次，它的三个读者取这一处；resource-catalog 的房间投影不取 task-execution，自己的形状只有两个字段。
// ③ 两个检查的签名：收端口类型、返回 void，没有 `unknown` 与 `asserts`。
// ④ 行为：完整接收者通过；缺任一方法、传 null 或非对象被拒绝，错误类型与消息不变。
// ⑤ 编译期断言：task-execution 的投影可赋值给 resource-catalog 的形状；两个检查收的就是那两个端口类型。
//
// 覆盖范围（C12）：① 覆盖 backend 全部生产源码；② ③ 只读点名的文件；④ 是两个检查函数本身的行为（方法清单取自 `rfc511` 同一来源的端口声明）；
// ⑤ 由 `tsc` 检查。房间投影与预算投影的结果由既有的工作组用例覆盖。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import type {
  RoundLedgerRow,
  WorkgroupRoomHostRun,
  WorkgroupRoomRunSelection,
} from '../src/modules/resource-catalog/application/workgroups/workgroupRoomProjection'
import type { IsolationWorkspaceScope } from '../src/modules/source-control/application/ports/isolationWorkspace'
import type { WorkspaceUploadContent } from '../src/modules/source-control/application/ports/workspaceUploadContent'
import {
  requireIsolationWorkspaceScope,
  requireWorkspaceUploadContent,
} from '../src/modules/source-control/application/workspacePorts'
import type { WorkgroupHostLedgerRun } from '../src/modules/task-execution/application/ports/workgroupTurnsOperations'
import type { WorkgroupRunSelectionProjection } from '../src/modules/task-execution/domain/runSelection/workgroupProjection'
import type { WorkgroupTaskRoomHostRunSnapshot } from '../src/modules/task-execution/public/commands'

const SRC = resolve(import.meta.dir, '..', 'src')
const PLATFORM_FILE = 'platform/runSelectionProjection'
const OWNER_FILE = 'modules/task-execution/domain/runSelection/workgroupProjection'
const ROOM = 'modules/resource-catalog/application/workgroups/workgroupRoomProjection.ts'
const PORTS = 'modules/source-control/application/workspacePorts.ts'
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Module specifiers a file names (imports, re-exports, `import('…')` types), resolved to a path below `src`. */
function importedFiles(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const add = (specifier: string) => {
    const target = specifier.startsWith('@/')
      ? join(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(dirname(path), specifier)
        : null
    if (target !== null) out.push(slash(relative(SRC, target)))
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
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** The exported function declaration of a source text, by name. */
function functionOf(path: string, name: string): ts.FunctionDeclaration {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  const found = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  )
  if (found === undefined) throw new Error(`function ${name} not found in ${path}`)
  return found
}

const methodsOf = (names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, () => undefined]))

const SCOPE_METHODS = [
  'recoverKey',
  'chooseGeneration',
  'create',
  'restore',
  'head',
  'submodulePresence',
  'changedFiles',
  'blobHashes',
  'snapshot',
  'merge',
  'undoShard',
  'discard',
  'resolveConflict',
  'completeHumanConflict',
] as const
const UPLOAD_METHODS = ['prepareTarget', 'file', 'entry', 'read', 'remove', 'write'] as const

// Compile-time: the owner's projection is what Resource Catalog's shape accepts, on both row kinds; the checks take the
// port types; the method lists above name real members of the two ports.
const ownerProjectionFitsTheRoomShape = (
  selection: WorkgroupRunSelectionProjection,
): WorkgroupRoomRunSelection => selection
const snapshotSelectionFitsARoomRun = (
  selection: WorkgroupTaskRoomHostRunSnapshot['selection'],
): WorkgroupRoomHostRun['selection'] => selection
const ledgerSelectionFitsARoundRow = (
  selection: WorkgroupHostLedgerRun['selection'],
): RoundLedgerRow['selection'] => selection
const scopeCheckTakesThePort = (scope: IsolationWorkspaceScope): void =>
  requireIsolationWorkspaceScope(scope)
const uploadCheckTakesThePort = (content: WorkspaceUploadContent): void =>
  requireWorkspaceUploadContent(content)
const scopeMethodsAreMembers: readonly (keyof IsolationWorkspaceScope)[] = SCOPE_METHODS
const uploadMethodsAreMembers: readonly (keyof WorkspaceUploadContent)[] = UPLOAD_METHODS

describe('RFC-570 —— 投影不再放在 platform', () => {
  test('平台文件不存在，全部生产源码不取它', () => {
    expect(existsSync(join(SRC, `${PLATFORM_FILE}.ts`))).toBe(false)
    const files = walk(SRC)
    expect(files.length).toBeGreaterThanOrEqual(3000)
    expect(
      files.flatMap((path) =>
        importedFiles(path, readFileSync(path, 'utf8'))
          .filter((target) => target === PLATFORM_FILE)
          .map(() => slash(relative(SRC, path))),
      ),
    ).toEqual([])
  }, 120_000)

  test('负对照：别名、相对路径、转出与 import 类型都会被认出；别的文件不算', () => {
    const at = join(SRC, 'modules', 'task-execution', 'public', 'probe.ts')
    expect(
      importedFiles(
        at,
        "import type { WorkgroupRunSelectionProjection } from '@/platform/runSelectionProjection'\n" +
          "export type { WorkgroupRunSelectionProjection } from '../../../platform/runSelectionProjection'\n" +
          "type P = import('@/platform/runSelectionProjection').WorkgroupRunSelectionProjection\n" +
          "import type { RunSlot } from '../domain/runSelection/slots'\n" +
          "import { ulid } from 'ulid'\n",
      ).filter((target) => target === PLATFORM_FILE),
    ).toEqual([PLATFORM_FILE, PLATFORM_FILE, PLATFORM_FILE])
  })
})

describe('RFC-570 —— 投影归 task-execution，resource-catalog 用自己的形状', () => {
  test('投影只声明一次；三个读者取 owner 的 domain 文件', () => {
    const declared = walk(SRC).filter((path) =>
      /\b(?:interface|type) WorkgroupRunSelectionProjection\b/.test(readFileSync(path, 'utf8')),
    )
    expect(declared.map((path) => slash(relative(SRC, path)))).toEqual([`${OWNER_FILE}.ts`])
    for (const reader of [
      'modules/task-execution/public/commands.ts',
      'modules/task-execution/application/ports/workgroupTurnsOperations.ts',
      'modules/task-execution/infrastructure/runSelection/workgroupProjection.ts',
    ])
      expect([reader, importedFiles(join(SRC, reader), read(reader)).includes(OWNER_FILE)]).toEqual(
        [reader, true],
      )
  }, 120_000)

  test('房间投影不取 task-execution；自己的形状只有它读的两个字段', () => {
    expect(
      importedFiles(join(SRC, ROOM), read(ROOM)).filter((target) =>
        target.startsWith('modules/task-execution/'),
      ),
    ).toEqual([])
    const source = ts.createSourceFile(ROOM, read(ROOM), ts.ScriptTarget.Latest, true)
    const shape = source.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === 'WorkgroupRoomRunSelection',
    )
    expect(shape?.members.map((member) => member.getText(source))).toEqual([
      'readonly sequence: number',
      'readonly legacyGroupCurrent: boolean',
    ])
    const text = read(ROOM)
    expect(text.split('readonly selection: WorkgroupRoomRunSelection').length - 1).toBe(2)
    expect(text).not.toContain('WorkgroupRunSelectionProjection')
    // The only selection facts the file reads.
    expect([...new Set(text.match(/\bselection\.\w+/g))].sort()).toEqual([
      'selection.legacyGroupCurrent',
      'selection.sequence',
    ])
  })
})

describe('RFC-570 —— 两个完整性检查收端口类型', () => {
  test('签名：一个具名类型的入参、返回 void，没有 unknown 与 asserts', () => {
    for (const [name, type] of [
      ['requireIsolationWorkspaceScope', 'IsolationWorkspaceScope'],
      ['requireWorkspaceUploadContent', 'WorkspaceUploadContent'],
    ] as const) {
      const declaration = functionOf(PORTS, name)
      expect([
        name,
        declaration.parameters.map((parameter) => parameter.getText()),
        declaration.type?.getText(),
      ]).toEqual([name, [`value: ${type}`], 'void'])
      // Neither the signature nor the body widens or re-asserts the receiver.
      expect([name, /\bunknown\b|\basserts\b|\bas\s+\w/.test(declaration.getText())]).toEqual([
        name,
        false,
      ])
    }
  })

  test('隔离工作区作用域：完整的通过；缺任一方法、null 与非对象被拒绝', () => {
    expect(() => requireIsolationWorkspaceScope(methodsOf(SCOPE_METHODS) as never)).not.toThrow()
    const refusal = new TypeError('Isolation requires a complete workspace scope')
    for (const missing of SCOPE_METHODS)
      expect(() =>
        requireIsolationWorkspaceScope(
          methodsOf(SCOPE_METHODS.filter((name) => name !== missing)) as never,
        ),
      ).toThrow(refusal)
    for (const value of [null, 'scope', 7, { ...methodsOf(SCOPE_METHODS), create: 'x' }])
      expect(() => requireIsolationWorkspaceScope(value as never)).toThrow(refusal)
  })

  test('上传内容：完整的通过；缺任一方法、null 与非对象被拒绝', () => {
    expect(() => requireWorkspaceUploadContent(methodsOf(UPLOAD_METHODS) as never)).not.toThrow()
    const refusal = new TypeError('Workspace uploads require a complete content receiver')
    for (const missing of UPLOAD_METHODS)
      expect(() =>
        requireWorkspaceUploadContent(
          methodsOf(UPLOAD_METHODS.filter((name) => name !== missing)) as never,
        ),
      ).toThrow(refusal)
    for (const value of [null, 'content', 7, { ...methodsOf(UPLOAD_METHODS), write: 'x' }])
      expect(() => requireWorkspaceUploadContent(value as never)).toThrow(refusal)
  })

  test('形状对得上（编译期由 tsc 检查，这里留运行期锚点）', () => {
    for (const bind of [
      ownerProjectionFitsTheRoomShape,
      snapshotSelectionFitsARoomRun,
      ledgerSelectionFitsARoundRow,
      scopeCheckTakesThePort,
      uploadCheckTakesThePort,
    ])
      expect(typeof bind).toBe('function')
    expect(scopeMethodsAreMembers.length).toBe(14)
    expect(uploadMethodsAreMembers.length).toBe(6)
  })
})
