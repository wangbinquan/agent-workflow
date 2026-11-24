// RFC-566 — development-automation 不再按 integration 的名字取适配绑定与流水线执行类型（RFC-294 S9 第二十一步）。
//
// 为什么存在：目标 DAG 上是 integration 消费 development-automation（并实现它的 `development-effect-spi`），反方向不是边。此前
// development-automation 的装配根与交付 provider 取 integration 的 public：一是为了声明四个“研发用途选择”接口（只有 bootstrap 读），二是给流水线
// 证据执行面写类型（本模块其实早有自己的端口）。RFC-566 把用途选择声明到 bootstrap，执行面改用本模块的端口。锁四件事：
// ① development-automation 全部源码取 integration 的只剩指定 adapter 按类型取 `composition/required-ports`（判据带负对照）。
// ② 四个用途选择接口只声明在 bootstrap 的 `developmentPurposeRoot.ts`；development-automation 的装配根不声明、不转出它们，也不转出流水线执行
//    类型；bootstrap 里读它们的三个文件从 `developmentPurposeRoot` 取。
// ③ development-automation 的两个装配文件与交付 provider 用本模块的 `SelectedPipelineEvidenceRunnerPort`；integration 的 public 不再交出
//    `SelectedPipelineEvidenceExecution`（带正对照）。
// ④ 编译期断言：integration 的执行面交得进 development-automation 的端口与两处入参；bootstrap 的用途选择就是部署选择里那一格的类型。
//
// 覆盖范围（C12）：① 覆盖 development-automation 的全部源码；② 覆盖全部模块与 bootstrap 的源码；③ 只读点名的文件；④ 由 `tsc` 检查。运行期行为
// 由既有的用途暂存、流水线证据与部署选择用例覆盖（本 RFC 只换类型的声明处）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import type { DeploymentSelections } from '../src/bootstrap/deploymentProfile'
import type {
  DevelopmentPurposeSelection,
  PipelinePurposeSelection,
  SelectedDevelopmentPurposeRoot,
} from '../src/bootstrap/developmentPurposeRoot'
import type { SelectedPipelineEvidenceRunnerPort } from '../src/modules/development-automation/application/ports/reconcilerPorts'
import type { composeDevelopmentPipelineDeps } from '../src/modules/development-automation/composition/developmentDelivery'
import type { createDevelopmentDeliveryProvider } from '../src/modules/development-automation/infrastructure/developmentDeliveryProvider'
import type { SelectedPipelineEvidenceExecution } from '../src/modules/integration/application/developmentPipelineAdapter'
import type { composeSelectedPipelineEvidenceRunnerFor } from '../src/modules/integration/composition/pipelineEvidence'

const SRC = resolve(import.meta.dir, '..', 'src')
const MODULES = join(SRC, 'modules')
const CONSUMER = 'development-automation'
const PROVIDER = 'integration'
const SELECTIONS = [
  'RequirementPurposeSelection',
  'PipelinePurposeSelection',
  'DevelopmentPurposeSelection',
  'SelectedDevelopmentPurposeRoot',
]
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Imports, re-exports, dynamic imports and `import('…')` types reaching integration, as `<rest> (<type|value>)`. */
function providerEdges(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const add = (specifier: string, typeOnly: boolean) => {
    const target = specifier.startsWith('@/')
      ? join(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(dirname(path), specifier)
        : null
    if (target === null) return
    const rest = new RegExp(`^${PROVIDER}/(.+)$`).exec(slash(relative(MODULES, target)))?.[1]
    if (rest !== undefined) out.push(`${rest} (${typeOnly ? 'type' : 'value'})`)
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      add(
        node.moduleSpecifier.text,
        clause?.isTypeOnly === true ||
          (clause !== undefined &&
            clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)),
      )
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier.text, node.isTypeOnly)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    )
      add(node.arguments[0].text, false)
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      add(node.argument.literal.text, true)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** Top-level interface and type alias declarations of a file, by name. */
function declaredTypes(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) =>
    ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
      ? [statement.name.text]
      : [],
  )
}

/** Names a file exports: declarations with `export`, and `export { … }` lists (with or without a source). */
function exportedNames(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) => {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    )
      return statement.exportClause.elements.map((element) => element.name.text)
    const exported =
      ts.canHaveModifiers(statement) &&
      (ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
        false)
    if (!exported) return []
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.flatMap((declaration) =>
        ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
      )
    return (ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isClassDeclaration(statement)) &&
      statement.name !== undefined
      ? [statement.name.text]
      : []
  })
}

function namesImportedFrom(path: string, specifier: string): string[] {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== specifier
    )
      return []
    const bindings = statement.importClause?.namedBindings
    return bindings !== undefined && ts.isNamedImports(bindings)
      ? bindings.elements.map((element) => (element.propertyName ?? element.name).text)
      : []
  })
}

// Compile-time: Integration's execution still reaches Development Automation's port, and bootstrap's selection is the
// deployment slot.
type IntegrationRunner = ReturnType<typeof composeSelectedPipelineEvidenceRunnerFor>
const executionFitsRunnerPort = (
  execution: SelectedPipelineEvidenceExecution,
): SelectedPipelineEvidenceRunnerPort => execution
const runnerFitsPipelineDeps = (
  runner: IntegrationRunner,
): Parameters<typeof composeDevelopmentPipelineDeps>[0] => runner
const runnerFitsDeliveryProvider = (
  runner: IntegrationRunner,
): Parameters<typeof createDevelopmentDeliveryProvider>[0]['pipeline'] => runner
const selectionIsTheDeploymentSlot = (
  selection: DevelopmentPurposeSelection,
): DeploymentSelections['developmentPurposes'] => selection
const deploymentSlotIsTheSelection = (
  slot: DeploymentSelections['developmentPurposes'],
): DevelopmentPurposeSelection => slot
const pipelineSelectionBindsTheRunner = (
  selection: PipelinePurposeSelection,
): Parameters<typeof composeSelectedPipelineEvidenceRunnerFor>[1] => selection
const rootCarriesTheSelection = (
  root: SelectedDevelopmentPurposeRoot,
): DevelopmentPurposeSelection => root
// Both directions: the provider's pipeline input is the runner port itself, not a wider or narrower type.
const providerPipelineIsTheRunnerPort = (
  pipeline: Parameters<typeof createDevelopmentDeliveryProvider>[0]['pipeline'],
): SelectedPipelineEvidenceRunnerPort => pipeline
const runnerPortIsTheProviderPipeline = (
  port: SelectedPipelineEvidenceRunnerPort,
): ReturnType<typeof createDevelopmentDeliveryProvider>['pipeline'] => port

describe('RFC-566 —— development-automation 不按名字取 integration', () => {
  test('全部源码里取 integration 的只剩指定 adapter 按类型取 required-ports', () => {
    const root = join(MODULES, CONSUMER)
    const files = walk(root)
    expect(files.length).toBeGreaterThanOrEqual(230)
    expect(
      [
        ...new Set(
          files.flatMap((path) =>
            providerEdges(path, readFileSync(path, 'utf8')).map(
              (edge) => `${slash(relative(root, path))} -> ${edge}`,
            ),
          ),
        ),
      ].sort(),
    ).toEqual(['application/adapters/integration-adapter.ts -> composition/required-ports (type)'])
  }, 60_000)

  test('负对照：public、内部文件、值导入、转出、相对路径、动态 import 与 import 类型都会被认出，别的 context 不算', () => {
    const at = join(MODULES, CONSUMER, 'infrastructure', 'probe.ts')
    expect(
      providerEdges(
        at,
        "import type { A } from '@/modules/integration/public/participants'\n" +
          "import { b } from '@/modules/integration/composition/pipelineEvidence'\n" +
          "export type { C } from '../../integration/application/developmentPipelineAdapter'\n" +
          "const d = () => import('@/modules/integration/public/events')\n" +
          "import { type E } from '@/modules/integration/composition/required-ports'\n" +
          "type H = import('@/modules/integration/public/participants').RequirementAdapterBinding\n" +
          "import type { F } from '@/modules/source-control/public/participants'\n" +
          "import type { G } from '@agent-workflow/shared'\n",
      ),
    ).toEqual([
      'public/participants (type)',
      'composition/pipelineEvidence (value)',
      'application/developmentPipelineAdapter (type)',
      'public/events (value)',
      'composition/required-ports (type)',
      'public/participants (type)',
    ])
  })
})

describe('RFC-566 —— 研发用途选择声明在 bootstrap', () => {
  test('四个接口在全部模块与 bootstrap 的源码里只声明一处', () => {
    const files = [...walk(MODULES), ...walk(join(SRC, 'bootstrap'))]
    expect(files.length).toBeGreaterThanOrEqual(2600)
    const declared = files.flatMap((path) =>
      declaredTypes(path, readFileSync(path, 'utf8'))
        .filter((name) => SELECTIONS.includes(name))
        .map((name) => `${slash(relative(SRC, path))}#${name}`),
    )
    expect(declared.sort()).toEqual(
      SELECTIONS.map((name) => `bootstrap/developmentPurposeRoot.ts#${name}`).sort(),
    )
  }, 120_000)

  test('development-automation 的装配根不声明、不转出它们，也不转出流水线执行类型', () => {
    const path = `modules/${CONSUMER}/composition.ts`
    const exported = exportedNames(path, read(path))
    expect(exported.length).toBeGreaterThanOrEqual(30)
    expect(
      exported.filter(
        (name) => SELECTIONS.includes(name) || name === 'SelectedPipelineEvidenceExecution',
      ),
    ).toEqual([])
    // The selection's pipeline staging is this module's type, handed to bootstrap.
    expect(exported).toContain('PipelineStagingFactories')
  })

  test('bootstrap 里读它们的文件从 developmentPurposeRoot 取', () => {
    const sites: ReadonlyArray<readonly [string, string, string]> = [
      ['bootstrap/deploymentProfile.ts', './developmentPurposeRoot', 'DevelopmentPurposeSelection'],
      [
        'bootstrap/daemonModules/developmentAutomation.ts',
        '../developmentPurposeRoot',
        'SelectedDevelopmentPurposeRoot',
      ],
      [
        'bootstrap/daemonModules/digitalEmployee.ts',
        '../developmentPurposeRoot',
        'SelectedDevelopmentPurposeRoot',
      ],
    ]
    for (const [path, specifier, name] of sites)
      expect([path, name, namesImportedFrom(path, specifier).includes(name)]).toEqual([
        path,
        name,
        true,
      ])
    // The adapter bindings the selection extends come from Integration's public (bootstrap may name both modules).
    expect(
      namesImportedFrom(
        'bootstrap/developmentPurposeRoot.ts',
        '@/modules/integration/public/participants',
      ).sort(),
    ).toEqual(['ApprovalAdapterBinding', 'PipelineAdapterBinding', 'RequirementAdapterBinding'])
  })
})

describe('RFC-566 —— 流水线执行面用 development-automation 自己的端口', () => {
  test('两个装配文件与交付 provider 用 SelectedPipelineEvidenceRunnerPort', () => {
    const expected: ReadonlyArray<readonly [string, readonly string[]]> = [
      [
        `modules/${CONSUMER}/composition/pipelineEvidence.ts`,
        ['  runner: SelectedPipelineEvidenceRunnerPort,'],
      ],
      [
        `modules/${CONSUMER}/composition/developmentDelivery.ts`,
        ['  runner: SelectedPipelineEvidenceRunnerPort,'],
      ],
      [
        `modules/${CONSUMER}/infrastructure/developmentDeliveryProvider.ts`,
        [
          "import type { SelectedPipelineEvidenceRunnerPort } from '../application/ports/reconcilerPorts'",
          '  readonly pipeline: SelectedPipelineEvidenceRunnerPort',
        ],
      ],
    ]
    for (const [path, lines] of expected) {
      const text = read(path)
      // Whole lines: a widened or narrowed type on the same line is not the port.
      const present = text.split('\n')
      for (const line of lines)
        expect([path, line, present.includes(line)]).toEqual([path, line, true])
      expect([path, text.includes('SelectedPipelineEvidenceExecution')]).toEqual([path, false])
    }
    // The provider's interface, its input and its internal input all carry the port, and nothing else types a pipeline.
    const provider = read(
      `modules/${CONSUMER}/infrastructure/developmentDeliveryProvider.ts`,
    ).split('\n')
    expect(provider.filter((line) => /^\s*readonly pipeline\b/.test(line))).toEqual([
      '  readonly pipeline: SelectedPipelineEvidenceRunnerPort',
      '  readonly pipeline: SelectedPipelineEvidenceRunnerPort',
      '  readonly pipeline: SelectedPipelineEvidenceRunnerPort',
    ])
  })

  test('integration 的 public 不再交出流水线执行类型（正对照：适配绑定仍在）', () => {
    const files = walk(join(MODULES, PROVIDER, 'public'))
    expect(files.length).toBeGreaterThanOrEqual(4)
    const exported = files.flatMap((path) => exportedNames(path, readFileSync(path, 'utf8')))
    expect(exported.filter((name) => name === 'SelectedPipelineEvidenceExecution')).toEqual([])
    for (const name of [
      'RequirementAdapterBinding',
      'PipelineAdapterBinding',
      'ApprovalAdapterBinding',
    ])
      expect([name, exported.includes(name)]).toEqual([name, true])
  })

  test('执行面与用途选择的类型对得上（编译期由 tsc 检查，这里留运行期锚点）', () => {
    for (const bind of [
      executionFitsRunnerPort,
      runnerFitsPipelineDeps,
      runnerFitsDeliveryProvider,
      selectionIsTheDeploymentSlot,
      deploymentSlotIsTheSelection,
      pipelineSelectionBindsTheRunner,
      rootCarriesTheSelection,
      providerPipelineIsTheRunnerPort,
      runnerPortIsTheProviderPipeline,
    ])
      expect(typeof bind).toBe('function')
  })
})
