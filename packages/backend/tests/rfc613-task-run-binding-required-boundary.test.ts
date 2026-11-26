// RFC-613 — provider 运行期的驱动绑定必填，旧的逐次驱动直绑只供用例（RFC-294 S12 余项）。
//
// 为什么存在：task-execution 的 `composition/localTaskRunSelection.ts` 里，`bindProviderTaskRunParticipantsInput` 在没给驱动绑定时退回一条旧的
// 直绑分支（每次驱动从四个工厂现绑 prompt → archive → Agent → script，并把 provider 运行期的入参当作工厂的接收者）。bootstrap 从来都给绑定
// （单机或托管的任务运行选择绑定一次），只有用例走这条分支。现在绑定必填，旧直绑迁为 `tests/helpers/legacyTaskRunDriveBinding.ts`，
// 与单机选择共用 `createLocalTaskRunConfigurationBridge`；生产里的这条分支随之消失。锁四件事：
// ① 合同：`ProviderTaskRunBindingSelection` 的 `taskRunBinding` 必填（编译期），不再是联合类型；这个文件没有控制流，也不再导出旧直绑。
// ② 迁出：`src/` 里没有旧直绑与它的四个工厂名（语料下限 3,000）。
// ③ 行为：给了完整绑定时原样交回入参；绑定不完整时报错。
// ④ 负对照：判据认得出伪造组合文件里的分支与旧名字。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  bindProviderTaskRunParticipantsInput,
  type ProviderTaskRunBindingSelection,
} from '@/modules/task-execution/composition/localTaskRunSelection'
import type { TaskRunDriveBinding } from '@/modules/task-execution/composition/taskRunSelection'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'
import { compositionControlFlowSets, createGateCorpus } from './architecture/rfc294Gates'

const REPO = resolve(import.meta.dir, '../../..')
const SELECTION = 'packages/backend/src/modules/task-execution/composition/localTaskRunSelection.ts'
const RETIRED = [
  'composeLegacyTaskRunDriveBinding',
  'LegacyTaskRunComposition',
  'nodeRunPromptsFor',
  'portArtifactsFor',
]
const CORPUS_TIMEOUT = 60_000

// ① The drive binding is required.
type Assert<T extends true> = T
export type BindingRequired = Assert<
  object extends Pick<ProviderTaskRunBindingSelection, 'taskRunBinding'> ? false : true
>

function retiredNames(unit: SourceUnit): string[] {
  const found = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && RETIRED.includes(node.text)) found.add(`${unit.path}:${node.text}`)
    node.forEachChild(visit)
  }
  visit(unit.source)
  return [...found].sort()
}

const controlFlow = (unit: SourceUnit) =>
  compositionControlFlowSets(createGateCorpus([unit]))['composition-control-flow-task-execution'] ??
  []

describe('RFC-613 —— provider 运行期的驱动绑定必填，旧直绑只供用例', () => {
  test('选择文件没有控制流，绑定不是联合类型，也不导出旧直绑', () => {
    const unit = sourceUnit(SELECTION, readFileSync(resolve(REPO, SELECTION), 'utf8'))
    expect(controlFlow(unit)).toEqual([])
    expect(retiredNames(unit)).toEqual([])
    const declaration = unit.source.statements.find(
      (statement) =>
        (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
        statement.name.text === 'ProviderTaskRunBindingSelection',
    )
    expect(declaration !== undefined && ts.isInterfaceDeclaration(declaration)).toBe(true)
    const member =
      declaration !== undefined && ts.isInterfaceDeclaration(declaration)
        ? declaration.members.find(
            (element) => element.name?.getText(unit.source) === 'taskRunBinding',
          )
        : undefined
    expect(member !== undefined && ts.isPropertySignature(member)).toBe(true)
    expect(member?.questionToken).toBeUndefined()
  })

  test(
    'src 里没有旧直绑与它的四个工厂名',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(units.flatMap(retiredNames)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('给了完整绑定时原样交回入参，不完整时报错', () => {
    const binding: TaskRunDriveBinding = { bind: () => Promise.reject(new Error('unused')) }
    const input = { taskRunBinding: binding, marker: 1 }
    expect(bindProviderTaskRunParticipantsInput(input)).toBe(input)
    expect(() =>
      bindProviderTaskRunParticipantsInput({
        taskRunBinding: {} as unknown as TaskRunDriveBinding,
      }),
    ).toThrow('Task provider requires a complete run binding')
  })
})

describe('RFC-613 —— 负对照（伪造源码）', () => {
  test('判据认得出伪造组合文件里的分支与旧名字', () => {
    const path = 'packages/backend/src/modules/task-execution/composition/probe.ts'
    const unit = sourceUnit(
      path,
      [
        'export function bind(input: { taskRunBinding?: unknown; nodeRunPromptsFor?: unknown }) {',
        '  if (input.taskRunBinding !== undefined) return input',
        '  return input.nodeRunPromptsFor',
        '}',
      ].join('\n'),
    )
    expect(controlFlow(unit)).toEqual([`${path}:2:branch`])
    expect(retiredNames(unit)).toEqual([`${path}:nodeRunPromptsFor`])
  })
})
