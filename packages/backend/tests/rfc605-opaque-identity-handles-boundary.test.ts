// RFC-605 — 不透明身份引用改为带品牌的句柄，任务房间结果不再带事件引用（RFC-294 S9 余项）。
//
// 为什么存在：development-automation 的证据暂存命名空间 / 引用与 integration 的适配器配置 / 程序引用都带一个 `reference: object`——实现铸造一个
// 空对象、按它的身份做键，消费方只携带。检测器把 `object` 记为开放类型；design §3.3 对这类值的形态是“带品牌的 id”。它们现在是平台的
// `OpaqueIdentity<Tag>`（指定的平台合同类型）。task-execution 任务房间参与方的结果原带 `CommittedEventRef`，唯一的事务属主从不读它，去掉。锁四件事：
// ① 检测器：`OpaqueIdentity` 放行；`object` 与同文件的其他导出照旧记债。
// ② 四个引用的 `reference` 是对应 tag 的 `OpaqueIdentity`；两个模块的 src 里不再有 `reference: {}` 字面量（判据带负对照）。
// ③ 原语：每次铸造得到不同的冻结空对象，可作 `WeakMap` 的键。
// ④ 任务房间参与方的 `continueTask` / `failTask` 结果不声明 `eventRef`，实现也不再返回它。
//
// 覆盖范围（C12）：① 在合成语料上跑检测器；② ④ 读源码；③ 跑原语。真实语料的逐条相等由 `rfc294-architecture-preflight` 执行。
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { mintOpaqueIdentity } from '@/platform/contracts/opaqueIdentity'
import { publicSurfaceViolations, sourceUnits } from './architecture/rfc294Gates'

const MODULES = join(import.meta.dir, '..', 'src', 'modules')

const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

/** `name: type` of the `reference` member of each named interface. */
function referenceTypes(path: string, names: readonly string[]): string[] {
  const source = parse(path, readFileSync(path, 'utf8'))
  return source.statements
    .filter(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && names.includes(statement.name.text),
    )
    .map((statement) => {
      const member = statement.members.find((m) => m.name?.getText(source) === 'reference')
      const type =
        member !== undefined && ts.isPropertySignature(member) ? member.type?.getText(source) : ''
      return `${statement.name.text}: ${type}`
    })
    .sort()
}

/** Casts, `satisfies` and parentheses do not change what was minted. */
function unwrapExpression(node: ts.Expression): ts.Expression {
  return ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node)
    ? unwrapExpression(node.expression)
    : node
}

/** Object-literal properties named `reference` whose value is an empty object literal (through any cast). */
function emptyReferenceLiterals(path: string, text: string): string[] {
  const source = parse(path, text)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'reference') {
      const value = unwrapExpression(node.initializer)
      if (ts.isObjectLiteralExpression(value) && value.properties.length === 0)
        found.push(
          `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
        )
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const sourceFiles = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))

describe('RFC-605 —— 不透明身份引用与任务房间结果', () => {
  test('检测器：OpaqueIdentity 放行，object 与同文件的其他导出照旧记债', () => {
    const probe = (body: string) =>
      publicSurfaceViolations(
        sourceUnits({ 'packages/backend/src/modules/gamma/public/types.ts': body }),
      )
    expect(
      probe(
        [
          "import type { OpaqueIdentity } from '@/platform/contracts/opaqueIdentity'",
          "export interface GammaRef { readonly kind: 'gamma'; readonly reference: OpaqueIdentity<'gamma'> }",
        ].join('\n'),
      ),
    ).toEqual([])
    expect(
      probe(
        [
          "import type { OpaqueIdentityTag } from '@/platform/contracts/opaqueIdentity'",
          'export interface GammaRef { readonly reference: object; readonly tag: OpaqueIdentityTag }',
        ].join('\n'),
      ),
    ).toEqual([
      'modules/gamma/public/types.ts#GammaRef: forbidden type import @/platform/contracts/opaqueIdentity#OpaqueIdentityTag',
      'modules/gamma/public/types.ts#GammaRef: unsafe/open type ObjectKeyword',
    ])
  })

  test('四个引用是对应 tag 的 OpaqueIdentity，src 里不再铸造空对象字面量', () => {
    expect(
      referenceTypes(
        join(MODULES, 'development-automation', 'application', 'ports', 'evidenceStaging.ts'),
        ['EvidenceStagingNamespace', 'EvidenceStagingReference'],
      ),
    ).toEqual([
      "EvidenceStagingNamespace: OpaqueIdentity<'evidence-staging-namespace'>",
      "EvidenceStagingReference: OpaqueIdentity<'evidence-staging'>",
    ])
    expect(
      referenceTypes(
        join(MODULES, 'integration', 'application', 'ports', 'developmentAdapterEffects.ts'),
        ['AdapterConfigurationReference', 'AdapterProgramReference'],
      ),
    ).toEqual([
      "AdapterConfigurationReference: OpaqueIdentity<'development-adapter-configuration'>",
      "AdapterProgramReference: OpaqueIdentity<'development-adapter-program'>",
    ])
    const files = [
      ...sourceFiles(join(MODULES, 'development-automation')),
      ...sourceFiles(join(MODULES, 'integration')),
    ]
    expect(files.length).toBeGreaterThanOrEqual(300)
    expect(
      files.flatMap((file) => emptyReferenceLiterals(file, readFileSync(file, 'utf8'))),
    ).toEqual([])
    // Negative control: the judgement finds an empty literal and ignores a minted token or a non-empty object.
    expect(
      emptyReferenceLiterals(
        'probe.ts',
        [
          "const a = { kind: 'x', reference: {} }",
          "const b = { kind: 'x', reference: mintOpaqueIdentity<'x'>() }",
          'const c = { reference: { id: 1 } }',
          "const d = { kind: 'x', reference: {} as never }",
          'const e = { reference: ({}) satisfies object }',
        ].join('\n'),
      ),
    ).toEqual(['probe.ts:1', 'probe.ts:4', 'probe.ts:5'])
  })

  test('原语：每次铸造得到不同的冻结空对象，可作 WeakMap 的键', () => {
    const first = mintOpaqueIdentity<'probe'>()
    const second = mintOpaqueIdentity<'probe'>()
    expect(first).not.toBe(second)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.keys(first)).toEqual([])
    const map = new WeakMap<object, string>([[first, 'first']])
    expect([map.get(first), map.get(second)]).toEqual(['first', undefined])
  })

  test('任务房间参与方的结果不再带事件引用', () => {
    const commands = join(MODULES, 'task-execution', 'public', 'commands.ts')
    const source = parse(commands, readFileSync(commands, 'utf8'))
    const participant = source.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) &&
        statement.name.text === 'WorkgroupTaskRoomTaskParticipantInTx',
    )
    const members: readonly ts.TypeElement[] = participant?.members ?? []
    const results = members
      .filter((member): member is ts.MethodSignature => ts.isMethodSignature(member))
      .filter((member) => ['continueTask', 'failTask'].includes(member.name.getText(source)))
      .map((member) => `${member.name.getText(source)}: ${member.type?.getText(source) ?? ''}`)
    expect(results).toHaveLength(2)
    for (const result of results) expect(result).not.toContain('eventRef')
    expect(results.join('\n')).toContain('closedHolderIds')
    const implementation = readFileSync(
      join(MODULES, 'task-execution', 'infrastructure', 'workgroupTaskRoomTaskParticipant.ts'),
      'utf8',
    )
    expect(implementation).not.toMatch(/\beventRef\b/)
    expect(implementation).toContain('await appendTaskLifecycleTransitionCommittedEvent(tx, {')
  })
})
