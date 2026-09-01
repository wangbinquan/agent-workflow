// RFC-317 T28（LC-04）—— 通用任务状态写点必须**不点名任何集成来源**。
//
// 背景：`services/lifecycle.ts` 是 commons-manifest 里 `core: true` 的内核
// （`settaskstatus-trysettaskstatus`），全部 ~25 个状态转移调用点都从它走。LC-04 抓到的
// 形态不是 if/switch——注入本身是对的——而是**半次反转**：策略被搬出去了、词汇表没搬。
// port 返回裸 `boolean`，于是「这次回收叫什么名字」只能由 kernel 自己铸
// （`workspacePruneCause: 'webhook-terminal' as const`），第二个来源要表达自己的原因，
// 唯一办法就是回来改这个通用写点。
//
// 本守卫钉住反转后的两个事实：
//   ① kernel 里**一个** `workspace_prune_cause` 取值都不出现（取值域从 schema 派生，不手抄）；
//   ② port 的入参属性集**逐字**等于中立集合——加一列集成归属就红。
//
// 判据一律走 AST：注释里写 'webhook-terminal'、字符串里提到 webhookTriggerId 都不算违规，
// 否则守卫会被散文满足（dev-gotchas 已记过这一类）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import ts from 'typescript'

import { mintedVocabulary, sourceUnit, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

const unitOf = (rel: string): SourceUnit =>
  sourceUnit(rel, readFileSync(resolve(REPO_ROOT, rel), 'utf8'))

const SCHEMA = 'packages/backend/src/db/schema.ts'
const LIFECYCLE = 'packages/backend/src/platform/persistence/sqlite/taskLifecycle.ts'

/**
 * 某个 drizzle 列声明的 `enum` 取值域，从 `schema.ts` 的 AST 里取。
 *
 * 手抄一份 `['webhook-terminal']` 到测试里，等于把词汇表写第三遍：schema 加一个取值时
 * 本守卫不会红，而是安静地放行那个新取值——正是它要防的东西。
 */
export function columnEnumValues(unit: SourceUnit, column: string): string[] {
  const values: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const first = node.arguments[0]
      const second = node.arguments[1]
      if (
        first !== undefined &&
        ts.isStringLiteral(first) &&
        first.text === column &&
        second !== undefined &&
        ts.isObjectLiteralExpression(second)
      ) {
        for (const property of second.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === 'enum' &&
            ts.isArrayLiteralExpression(property.initializer)
          ) {
            for (const element of property.initializer.elements) {
              if (ts.isStringLiteral(element)) values.push(element.text)
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return [...new Set(values)].sort()
}

/** `export type X = (row: { … }, …) => R` 的第一个参数的属性名集合。 */
export function portSubjectProperties(unit: SourceUnit, typeName: string): string[] | null {
  let found: string[] | null = null
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === typeName &&
      ts.isFunctionTypeNode(node.type)
    ) {
      const first = node.type.parameters[0]
      if (first !== undefined && first.type !== undefined && ts.isTypeLiteralNode(first.type)) {
        found = first.type.members
          .filter((member): member is ts.PropertySignature => ts.isPropertySignature(member))
          .flatMap((member) => (ts.isIdentifier(member.name) ? [member.name.text] : []))
          .sort()
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return found
}

/** 同一个类型别名的返回类型写成了什么（用类型名判断，不看结构）。 */
export function portReturnTypeName(unit: SourceUnit, typeName: string): string | null {
  let found: string | null = null
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === typeName &&
      ts.isFunctionTypeNode(node.type)
    ) {
      found = node.type.type.getText(unit.source)
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return found
}

const schemaUnit = unitOf(SCHEMA)
const lifecycleUnit = unitOf(LIFECYCLE)
const PRUNE_CAUSES = columnEnumValues(schemaUnit, 'workspace_prune_cause')

/**
 * port 允许出现的入参属性。**中立**的判据是：这些名字对任何来源都成立——任务 id、
 * 空间种类、以及回收墓碑三列（它们是 kernel 自己 CAS 条件的一部分）。
 * 任何一个「只有某个集成才有」的列出现在这里，就是本守卫要抓的东西。
 */
const NEUTRAL_SUBJECT = [
  'spaceKind',
  'taskId',
  'workspacePruneCause',
  'workspacePrunedAt',
  'workspacePruningAt',
]

describe('RFC-317 T28（LC-04）—— 通用状态写点的来源中立性', () => {
  test('语料非空：取值域派生得到、kernel 解析得到（任一为空则本守卫零预言力）', () => {
    expect(
      PRUNE_CAUSES.length,
      'workspace_prune_cause 的 enum 没派生出取值——列被改名或换了声明形态，' +
        '此时下面那条「kernel 不铸这些字面量」会因为词汇表为空而必然绿',
    ).toBeGreaterThanOrEqual(1)
    expect(lifecycleUnit.text.length).toBeGreaterThan(10_000)
  })

  test('kernel 里不出现任何 workspace_prune_cause 取值（词汇表属于注入方）', () => {
    expect(
      mintedVocabulary(lifecycleUnit, PRUNE_CAUSES),
      '通用状态写点自己铸了回收原因。原因属于**决定回收的那个来源**，' +
        'kernel 只负责把 port 给的 cause 原样写下去；一旦 kernel 认识某个原因，' +
        '第二个来源就只能回来改这个所有任务都要走的写点',
    ).toEqual([])
  })

  test('port 入参逐字等于中立集合（加一列集成归属就红）', () => {
    expect(
      portSubjectProperties(lifecycleUnit, 'TerminalWorkspacePrunePolicy'),
      'port 的入参里出现了只有某个集成才有的列。kernel 为了喂它就得在自己的 SELECT 里' +
        '选那一列——于是这个通用写点的类型签名与查询双双点名该集成，再也无法脱离它被抽取',
    ).toEqual(NEUTRAL_SUBJECT)
  })

  test('port 返回闭合联合而不是裸 boolean（退回 boolean 就红）', () => {
    expect(
      portReturnTypeName(lifecycleUnit, 'TerminalWorkspacePrunePolicy'),
      '返回 boolean 意味着「要不要回收」外置了、「叫什么名字」没外置——半次反转，' +
        'cause 只能由 kernel 自己铸',
    ).toBe('Promise<TerminalWorkspacePruneDecision>')
  })
})

describe('RFC-317 T28 自变异 —— 三条判据各配正反 fixture', () => {
  test('派生取值域：认得 enum 数组，认不出就是空（空 ⇒ 上面那条自曝零预言力）', () => {
    const unit = sourceUnit(
      'probe-schema.ts',
      `const t = sqliteTable('tasks', {\n` +
        `  cause: text('workspace_prune_cause', { enum: ['a-terminal', 'b-terminal'] }),\n` +
        `})\n`,
    )
    expect(columnEnumValues(unit, 'workspace_prune_cause')).toEqual(['a-terminal', 'b-terminal'])
    expect(columnEnumValues(unit, 'other_column')).toEqual([])
  })

  test('铸字面量会被抓到；注释 / 无关字符串不会（AST 判据，不被散文满足）', () => {
    const offending = sourceUnit(
      'probe.ts',
      `const x = { workspacePruneCause: 'webhook-terminal' as const }\n`,
    )
    expect(mintedVocabulary(offending, ['webhook-terminal']).length).toBe(1)

    const innocent = sourceUnit(
      'probe.ts',
      `// 历史上这里写死过 'webhook-terminal'，见 RFC-317 LC-04\n` +
        `function assertNodeRunSourceTerminationAdmission() {}\n` +
        `const scheduler = 1\n`,
    )
    expect(
      mintedVocabulary(innocent, ['webhook-terminal']),
      '注释里提到取值不是违规。finding 原本建议的 /webhook|schedule|mission/i 正则会连' +
        'Ad**mission** 和 scheduler 一起误伤——正是 dev-gotchas 记过的「正则读不懂散文」',
    ).toEqual([])
  })

  test('入参属性集：多一列就不等（这条 fixture 锁住 toEqual 的方向）', () => {
    const neutral = sourceUnit(
      'probe.ts',
      `export type P = (row: { taskId: string; spaceKind: S }, to: T) => D\n`,
    )
    expect(portSubjectProperties(neutral, 'P')).toEqual(['spaceKind', 'taskId'])

    const leaky = sourceUnit(
      'probe.ts',
      `export type P = (row: { taskId: string; webhookTriggerId: string | null }, to: T) => D\n`,
    )
    expect(portSubjectProperties(leaky, 'P')).toEqual(['taskId', 'webhookTriggerId'])
  })

  test('返回类型读得出；不是函数类型时返回 null 而不是假绿', () => {
    const fn = sourceUnit('probe.ts', `export type P = (row: {}, to: T) => Decision\n`)
    expect(portReturnTypeName(fn, 'P')).toBe('Decision')
    const notFn = sourceUnit('probe.ts', `export type P = { prune: boolean }\n`)
    expect(portReturnTypeName(notFn, 'P')).toBe(null)
  })
})
