// RFC-601 — 员工工作区与平台工作项装配的 provider 必填（RFC-294 W4-E8：可选 provider 的装配边界，员工一侧）。
//
// 为什么存在：两个员工装配从 application 入参继承了可选 provider（员工工作区的 `graphDelivery`，平台工作项的 `approvalGateway`、`pipelineEvidence`、
// `graphDelivery`、`mrFacts`），没给时 use case 给出“未接入”的结果或跳过图验证；daemon 都给，“没给”只在用例里出现——与 RFC-597 之前的开发自动化
// 装配同一类遗漏风险。现在装配入参把它们换成必填，use case 自己的可选成员与“未接入”分支不变。锁两件事：
// ① 两个装配入参接口里这 5 个成员都没有 `?`，且都在 `Omit` 的键里（不再继承 application 的可选版本）；编译期断言它们是必填键（判据带负对照）。
// ② 测试替身：`graphDeliveryWithoutDesign()` 的两个回答与真实图研发 MR 照看对没有图设计的案例的回答相同；`unusedEmployeePlatformProviders()` 给全
//    3 个 provider、每个方法被调用时抛出带名字的错误。
//
// 覆盖范围（C12）：① 只读两个装配文件，调用方由 `tsc` 全量核对；② 跑替身与真实图照看。RFC-396 的“缺图验证绑定”由 `rfc396-mr-lifecycle` 照旧覆盖。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import type { DevelopmentEmployeeWorkspaceCompositionInput } from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import type { DevelopmentEmployeePlatformWorkItemsCompositionInput } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { createGraphMrCare } from '@/modules/development-automation/application/graph-development/mrCare'
import {
  graphDeliveryWithoutDesign,
  unusedEmployeePlatformProviders,
} from './helpers/developmentAutomation'

const COMPOSITION = join(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'development-automation',
  'composition',
)
const FILES = [
  {
    path: join(COMPOSITION, 'digitalEmployeeWorkspace.ts'),
    input: 'DevelopmentEmployeeWorkspaceCompositionInput',
    providers: ['graphDelivery'],
  },
  {
    path: join(COMPOSITION, 'digitalEmployeePlatformWorkItems.ts'),
    input: 'DevelopmentEmployeePlatformWorkItemsCompositionInput',
    providers: ['approvalGateway', 'graphDelivery', 'mrFacts', 'pipelineEvidence'],
  },
] as const

// ① Compile-time: an optional key makes the empty object fit its `Pick`, so these are `true` only when the keys are required.
type IsRequired<T, K extends keyof T> = Record<never, never> extends Pick<T, K> ? never : true
const requiredProviders: [
  IsRequired<DevelopmentEmployeeWorkspaceCompositionInput, 'graphDelivery'>,
  IsRequired<DevelopmentEmployeePlatformWorkItemsCompositionInput, 'approvalGateway'>,
  IsRequired<DevelopmentEmployeePlatformWorkItemsCompositionInput, 'pipelineEvidence'>,
  IsRequired<DevelopmentEmployeePlatformWorkItemsCompositionInput, 'graphDelivery'>,
  IsRequired<DevelopmentEmployeePlatformWorkItemsCompositionInput, 'mrFacts'>,
] = [true, true, true, true, true]

const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

/** For one interface: its own provider members (`name` / `name?`) and the provider keys its `Omit` heritage drops. */
function providerShape(path: string, text: string, name: string, providers: readonly string[]) {
  const source = parse(path, text)
  const node = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  )
  const own = (node?.members ?? [])
    .filter((member) => providers.includes(member.name?.getText(source) ?? ''))
    .map((member) => member.name!.getText(source) + (member.questionToken ? '?' : ''))
    .sort()
  const omitted = (node?.heritageClauses ?? [])
    .flatMap((clause) => clause.types)
    .filter((type) => type.expression.getText(source) === 'Omit')
    .flatMap((type) => {
      const keys = type.typeArguments?.[1]
      const members = keys === undefined ? [] : ts.isUnionTypeNode(keys) ? keys.types : [keys]
      return members.map((member) => member.getText(source).replace(/^'|'$/g, ''))
    })
    .filter((key) => providers.includes(key))
    .sort()
  return { own, omitted }
}

describe('RFC-601 —— 员工工作区与平台工作项装配的 provider 必填', () => {
  test('两个装配入参把 provider 换成必填成员', () => {
    for (const file of FILES)
      expect(
        providerShape(file.path, readFileSync(file.path, 'utf8'), file.input, file.providers),
      ).toEqual({ own: [...file.providers], omitted: [...file.providers] })
    expect(requiredProviders).toEqual([true, true, true, true, true])
  })

  test('负对照：可选成员与没从 Omit 去掉的继承都会被认出，别的成员不算', () => {
    expect(
      providerShape(
        'probe.ts',
        'interface DevelopmentEmployeePlatformWorkItemsCompositionInput extends Omit<\n' +
          "  DevelopmentEmployeePlatformWorkItemsInput,\n  'now' | 'graphDelivery'\n> {\n" +
          '  readonly graphDelivery: G\n' +
          '  readonly mrFacts?: M\n' +
          '  readonly now?: () => number\n' +
          '}\n',
        'DevelopmentEmployeePlatformWorkItemsCompositionInput',
        FILES[1].providers,
      ),
    ).toEqual({ own: ['graphDelivery', 'mrFacts?'], omitted: ['graphDelivery'] })
  })

  test('“没有图设计”的替身与真实图照看对没有图设计的案例回答相同', async () => {
    const unused = {} as never
    const real = createGraphMrCare({
      store: { findByCase: async () => null } as never,
      commands: unused,
      execution: unused,
      sourceControl: unused,
      persistence: unused,
      verification: unused,
      workspacePath: () => '/never',
    })
    const double = graphDeliveryWithoutDesign()
    const publish = { caseId: 'case-without-design' } as Parameters<typeof real.beforePublish>[0]
    const repair = { caseId: 'case-without-design', roundRef: 'round-1' }
    expect([await double.beforePublish(publish), await double.repairMaterial(repair)]).toEqual([
      await real.beforePublish(publish),
      await real.repairMaterial(repair),
    ])
    expect(await double.beforePublish(publish)).toEqual({ ok: true })
    expect(await double.repairMaterial(repair)).toBeNull()
  })

  test('平台工作项的三个 provider 替身给全，每个方法被调用就抛出带名字的错误', () => {
    const providers = unusedEmployeePlatformProviders() as unknown as Record<
      string,
      Record<string, () => unknown>
    >
    expect(Object.keys(providers).sort()).toEqual([
      'approvalGateway',
      'mrFacts',
      'pipelineEvidence',
    ])
    const calls = Object.entries(providers).flatMap(([provider, port]) =>
      Object.entries(port).map(([method, call]) => {
        try {
          call()
          return `${provider}.${method}: returned`
        } catch (error) {
          return `${provider}.${method}: ${(error as Error).message}`
        }
      }),
    )
    expect(calls).toHaveLength(7)
    expect(calls.filter((line) => !line.endsWith(' is not used by this test'))).toEqual([])
  })
})
