// RFC-597 — development-automation 的装配不再接受缺省的 provider（RFC-294 W4-E8 第一步：可选袋的装配边界）。
//
// 为什么存在：`composeDevelopmentAutomation` 的 11 个 provider（需求源、两个动作启动器、审批网关、候选派生 / 发布链 / 冲突合并、仓库远端、
// MR 效果、流水线证据、MR 事实采集）原先都是可选成员，没给的不进 `ReconcilerPorts`，mission 走到那一步被 `*-not-wired` 挡下。生产上只有
// daemon 调它、11 个都给；“没给”只在用例里出现，但出过事（dual-provider-parity-audit-2026-09-04 F-H2-2：PostgreSQL daemon 漏了两个启动器，
// `01e4b1b7b` 修复）。现在 11 个归在必填的 `DevelopmentAutomationProviders` 下，漏给即编译错误。锁四件事：
// ① `DevelopmentAutomationProviders` 恰好是这 11 个成员、都没有 `?`；装配入参继承它、自己不再声明这些名字（判据带负对照）。
// ② 装配不再按“某个 provider 给没给”分支：没有以它为条件的条件表达式与 `if`、没有 `deps.<provider>!`；端口与物化器逐个读
//    `deps.<provider>`（判据带负对照）。
// ③ 用例的测试替身给全 11 个 provider，每个方法一被调用就抛出带名字的错误。
// ④ 编译期：`DevelopmentAutomationProviders` 没有可选键（typecheck 执行；daemon 漏给由 `tsc` 在装配处报错）。
//
// 覆盖范围（C12）：① ② 只读模块装配文件；③ 跑替身；④ 由 typecheck 执行。行为由既有用例覆盖（调用装配的 9 个用例文件与 RFC-359 的 P0 变异
// `p0-9-launchers`——它在运行期复现漏给启动器，reconciler 照旧得到 `*-launcher-not-wired`）。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import type { DevelopmentAutomationProviders } from '@/modules/development-automation/composition'
import { unusedDevelopmentProviders } from './helpers/developmentAutomation'

const COMPOSITION = join(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'development-automation',
  'composition.ts',
)
const PROVIDERS = [
  'agentLauncher',
  'approvalGateway',
  'candidateDelivery',
  'changeCandidate',
  'conflictMerge',
  'mergeRequestFacts',
  'mrEffects',
  'pipelineEvidence',
  'repoRemote',
  'requirementSource',
  'scriptLauncher',
] as const
const PROVIDER_NAMES: ReadonlySet<string> = new Set(PROVIDERS)

// ④ Compile-time: an optional key makes the empty object fit its `Pick`, so this union is `never` only when none is optional.
type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never
}[keyof T]
const noOptionalProvider: [OptionalKeys<DevelopmentAutomationProviders>] extends [never]
  ? true
  : never = true

const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

function interfaceOf(source: ts.SourceFile, name: string): ts.InterfaceDeclaration | undefined {
  return source.statements.find(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === name,
  )
}

/** The provider interface's members as `name` or `name?`, and the options' own provider names and heritage. */
function providerShape(source: ts.SourceFile) {
  const providers = interfaceOf(source, 'DevelopmentAutomationProviders')
  const options = interfaceOf(source, 'DevelopmentAutomationCompositionOptions')
  const named = (node: ts.InterfaceDeclaration | undefined): ts.PropertySignature[] => {
    const members: readonly ts.TypeElement[] = node?.members ?? []
    return members.filter(ts.isPropertySignature)
  }
  return {
    providers: named(providers)
      .map((member) => member.name.getText(source) + (member.questionToken ? '?' : ''))
      .sort(),
    optionsOwnProviders: named(options)
      .map((member) => member.name.getText(source))
      .filter((name) => PROVIDER_NAMES.has(name))
      .sort(),
    optionsExtend: (options?.heritageClauses ?? []).flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(source)),
    ),
  }
}

/** `deps.<provider>` (also inside optional chains) — the name, or null. */
function providerRead(node: ts.Node, source: ts.SourceFile): string | null {
  if (!ts.isPropertyAccessExpression(node)) return null
  if (node.expression.getText(source) !== 'deps') return null
  return PROVIDER_NAMES.has(node.name.text) ? node.name.text : null
}

function mentionsProvider(node: ts.Node, source: ts.SourceFile): string | null {
  let found: string | null = null
  const visit = (child: ts.Node) => {
    if (found !== null) return
    found = providerRead(child, source)
    if (found === null) ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

/** Branches on whether a provider was given: conditions of `?:` and `if` that read one, and `deps.<provider>!`. */
function providerBranches(path: string, text: string): string[] {
  const source = parse(path, text)
  const found: string[] = []
  const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const visit = (node: ts.Node) => {
    const condition = ts.isConditionalExpression(node)
      ? node.condition
      : ts.isIfStatement(node)
        ? node.expression
        : undefined
    const branched = condition === undefined ? null : mentionsProvider(condition, source)
    if (branched !== null) found.push(`${at(node)}: branch on ${branched}`)
    if (ts.isNonNullExpression(node)) {
      const asserted = providerRead(node.expression, source)
      if (asserted !== null) found.push(`${at(node)}: ${asserted}!`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Initializers of the `ReconcilerPorts` literal and of the materializer's `source`, as `member <- text`. */
function providerAssignments(path: string, text: string): string[] {
  const source = parse(path, text)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.type?.getText(source) === 'ReconcilerPorts' &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      for (const property of node.initializer.properties)
        if (ts.isPropertyAssignment(property) && PROVIDER_NAMES.has(property.name.getText(source)))
          found.push(
            `${property.name.getText(source)} <- ${
              ts.isObjectLiteralExpression(property.initializer)
                ? property.initializer.properties
                    .map((member) => mentionsProvider(member, source) ?? '?')
                    .join(',')
                : property.initializer.getText(source)
            }`,
          )
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'createSelectedRequirementMaterializer'
    ) {
      const input = node.arguments[0]
      if (input !== undefined && ts.isObjectLiteralExpression(input))
        for (const property of input.properties)
          if (ts.isPropertyAssignment(property) && property.name.getText(source) === 'source')
            found.push(`materializer.source <- ${property.initializer.getText(source)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found.sort()
}

describe('RFC-597 —— development-automation 的装配不再接受缺省的 provider', () => {
  const text = readFileSync(COMPOSITION, 'utf8')

  test('11 个 provider 都必填，装配入参继承具名接口', () => {
    expect(providerShape(parse(COMPOSITION, text))).toEqual({
      providers: [...PROVIDERS],
      optionsOwnProviders: [],
      optionsExtend: ['DevelopmentAutomationProviders'],
    })
  })

  test('负对照：可选成员、入参自己声明 provider 与不继承都会被认出', () => {
    expect(
      providerShape(
        parse(
          'probe.ts',
          'interface DevelopmentAutomationProviders {\n' +
            '  readonly agentLauncher?: A\n' +
            '  readonly repoRemote: B\n' +
            '}\n' +
            'interface DevelopmentAutomationCompositionOptions {\n' +
            '  readonly appHome: string\n' +
            '  readonly mrEffects?: C\n' +
            '}\n',
        ),
      ),
    ).toEqual({
      providers: ['agentLauncher?', 'repoRemote'],
      optionsOwnProviders: ['mrEffects'],
      optionsExtend: [],
    })
  })

  test('装配不按 provider 给没给分支，端口与物化器逐个读 deps.<provider>', () => {
    expect(providerBranches(COMPOSITION, text)).toEqual([])
    expect(providerAssignments(COMPOSITION, text)).toEqual([
      'agentLauncher <- deps.agentLauncher',
      'approvalGateway <- deps.approvalGateway',
      'candidateDelivery <- deps.candidateDelivery',
      'changeCandidate <- deps.changeCandidate',
      'conflictMerge <- conflictMerge,conflictMerge,conflictMerge',
      'materializer.source <- deps.requirementSource',
      'mergeRequestFacts <- deps.mergeRequestFacts',
      'mrEffects <- deps.mrEffects',
      'pipelineEvidence <- deps.pipelineEvidence',
      'repoRemote <- deps.repoRemote',
      'scriptLauncher <- deps.scriptLauncher',
    ])
  })

  test('负对照：条件展开、if、可选链条件与非空断言都会被认出，读别的成员不算', () => {
    expect(
      providerBranches(
        'probe.ts',
        'const ports = {\n' +
          '  ...(deps.agentLauncher === undefined ? {} : { agentLauncher: deps.agentLauncher }),\n' +
          '  conflictMerge: { prepare: (input) => deps.conflictMerge!.prepare(input) },\n' +
          '  root: deps.appHome === undefined ? a : b,\n' +
          '}\n' +
          'if (deps.mrEffects?.ensure) run()\n',
      ),
    ).toEqual(['2: branch on agentLauncher', '3: conflictMerge!', '6: branch on mrEffects'])
  })

  test('测试替身给全 11 个 provider，每个方法被调用就抛出带名字的错误', () => {
    const providers = unusedDevelopmentProviders()
    expect(Object.keys(providers).sort()).toEqual([...PROVIDERS])
    const ports = providers as unknown as Record<string, Record<string, () => unknown>>
    const calls = Object.entries(ports).flatMap(([provider, port]) =>
      Object.entries(port).map(([method, call]) => {
        try {
          call()
          return `${provider}.${method}: returned`
        } catch (error) {
          return `${provider}.${method}: ${(error as Error).message}`
        }
      }),
    )
    expect(calls.length).toBe(27)
    expect(calls.filter((line) => !line.endsWith(' is not used by this test'))).toEqual([])
    expect(calls).toContain('agentLauncher.launch: agentLauncher.launch is not used by this test')
  })

  test('编译期断言存在（typecheck 执行）', () => {
    expect(noOptionalProvider).toBe(true)
  })
})
