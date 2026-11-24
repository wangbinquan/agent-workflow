// RFC-564 — 系统代理运行的词汇不再被目标 DAG 之外的 context 按 runtime-management 的名字取（RFC-294 S9 第十九步）。
//
// 锁四件事：
// ① 全部模块里，取 runtime-management 的文件只属于目标 DAG 上消费它的 context（`OFFERED_CONTEXT_EDGES` 里指向它的那几个），此外只剩
//    resource-catalog 的指定 adapter 按类型取 `composition/required-ports`（判据带负对照）。
// ② resource-catalog 的 MCP 诊断端口用自己的形状（诊断意图、运行参数、用量快照，事件接收用本模块已有的那个）；托管诊断读的托管能力
//    也是本模块的形状。
// ③ memory 的蒸馏端口从 task-execution 的系统代理运行合同上取词汇。
// ④ 编译期断言：这些形状与 runtime-management 的合同仍然对得上（bootstrap 与 task-execution 的运行器交接的就是它们）。
//
// 覆盖范围（C12）：① 覆盖 runtime-management 以外全部模块的源码；② ③ 只读点名的文件；④ 由 `tsc` 检查。运行期行为由既有的 MCP 诊断
// 与记忆蒸馏用例覆盖（本 RFC 只换类型的出处）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import type {
  ResolvedMemoryDistillRuntime,
  SelectedMemoryDistillRuntime,
  SystemAgentEventSinkV1 as MemoryDistillEventSink,
} from '../src/modules/memory/application/ports/distillWorkStore'
import type { McpDiagnosticEventSink } from '../src/modules/resource-catalog/application/mcps/runtimeDiagnosticsEffects'
import type {
  McpDiagnosticIntent,
  McpDiagnosticUsageSnapshot,
} from '../src/modules/resource-catalog/application/ports/mcpDiagnosticExecution'
import type { HostedInput } from '../src/modules/resource-catalog/infrastructure/crewstation/mcpDiagnosticsEffects'
import type {
  AgentMaterialContentReference,
  AgentMaterialIntent,
  RuntimeUsageSnapshot,
  SystemAgentEventSinkV1,
} from '../src/modules/runtime-management/public/participants'
import type {
  HostedRuntimeCapabilities,
  RuntimeKind,
  RuntimeObservationIdentity,
} from '../src/modules/runtime-management/public/types'
import { OFFERED_CONTEXT_EDGES } from './architecture/rfc294Target'

const SRC = resolve(import.meta.dir, '..', 'src')
const MODULES = join(SRC, 'modules')
const PROVIDER = 'runtime-management'
const read = (path: string) => readFileSync(join(MODULES, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Imports, re-exports, dynamic imports and `import('…')` types reaching runtime-management, as `<rest> (<type|value>)`. */
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

const exportedNames = (path: string): string[] => {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) =>
    (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ? [statement.name.text]
      : [],
  )
}

// Compile-time: the owners' shapes still meet runtime-management's contracts where bootstrap and the runners hand them over.
type DiagnosticIntentSlice = Pick<
  AgentMaterialIntent,
  | 'protocol'
  | 'injection'
  | 'prompt'
  | 'agentName'
  | 'systemPrompt'
  | 'resolvedProfiles'
  | 'freshAgentRun'
  | 'resumeSessionId'
>
const intentFits = (intent: McpDiagnosticIntent): DiagnosticIntentSlice => intent
const diagnosticSinkFits = (sink: McpDiagnosticEventSink): SystemAgentEventSinkV1 => sink
const usageFits = (usage: McpDiagnosticUsageSnapshot): RuntimeUsageSnapshot => usage
const usageArrives = (usage: RuntimeUsageSnapshot): McpDiagnosticUsageSnapshot => usage
const capabilitiesArrive = (
  read: () => Promise<HostedRuntimeCapabilities>,
): HostedInput['capabilities'] => read
const distillSinkFits = (sink: MemoryDistillEventSink): SystemAgentEventSinkV1 => sink
const distillSinkArrives = (sink: SystemAgentEventSinkV1): MemoryDistillEventSink => sink
const distillProtocolFits = (protocol: ResolvedMemoryDistillRuntime['protocol']): RuntimeKind =>
  protocol
const distillIdentityFits = (
  identity: NonNullable<ResolvedMemoryDistillRuntime['observationIdentity']>,
): RuntimeObservationIdentity => identity
const distillBindingFits = (
  binding: NonNullable<SelectedMemoryDistillRuntime['runtimeBinding']>,
): AgentMaterialContentReference => binding

describe('RFC-564 —— 只有目标 DAG 上的消费方按名字取 runtime-management', () => {
  test('别的模块全部源码里，取它的只属于 DAG 上的消费方，此外只剩 resource-catalog 的指定 adapter', () => {
    const consumers = new Set(
      OFFERED_CONTEXT_EDGES.filter(([, provider]) => provider === PROVIDER).map(
        ([consumer]) => consumer as string,
      ),
    )
    expect([...consumers].sort()).toEqual([
      'run-observability',
      'task-execution',
      'workspace-insight',
    ])
    const files = readdirSync(MODULES)
      .filter((name) => name !== PROVIDER)
      .flatMap((name) => walk(join(MODULES, name)))
    expect(files.length).toBeGreaterThanOrEqual(2300)
    const outside = [
      ...new Set(
        files.flatMap((path) => {
          const from = slash(relative(MODULES, path))
          if (consumers.has(from.split('/')[0]!)) return []
          return providerEdges(path, readFileSync(path, 'utf8')).map((edge) => `${from} -> ${edge}`)
        }),
      ),
    ].sort()
    expect(outside).toEqual([
      'resource-catalog/application/adapters/runtime-management-adapter.ts -> composition/required-ports (type)',
    ])
  }, 120_000)

  test('memory 的全部源码不取 runtime-management', () => {
    const root = join(MODULES, 'memory')
    const files = walk(root)
    expect(files.length).toBeGreaterThanOrEqual(30)
    expect(
      files.flatMap((path) =>
        providerEdges(path, readFileSync(path, 'utf8')).map(
          (edge) => `${slash(relative(root, path))} -> ${edge}`,
        ),
      ),
    ).toEqual([])
  })

  test('负对照：public、内部文件、值导入、转出、相对路径、动态 import 与 import 类型都会被认出，别的 context 不算', () => {
    const at = join(MODULES, 'memory', 'application', 'ports', 'probe.ts')
    expect(
      providerEdges(
        at,
        "import type { A } from '@/modules/runtime-management/public/participants'\n" +
          "import { b } from '@/modules/runtime-management/composition/localAgentMaterial'\n" +
          "export type { C } from '../../../runtime-management/application/ports/agentSessionEvents'\n" +
          "const d = () => import('@/modules/runtime-management/public/types')\n" +
          "type E = import('@/modules/runtime-management/public/types').RuntimeKind\n" +
          "import type { F } from '@/modules/task-execution/public/participants'\n" +
          "import type { G } from '@agent-workflow/shared'\n",
      ),
    ).toEqual([
      'public/participants (type)',
      'composition/localAgentMaterial (value)',
      'application/ports/agentSessionEvents (type)',
      'public/types (value)',
      'public/types (type)',
    ])
  })
})

describe('RFC-564 —— 词汇各有出处', () => {
  test('resource-catalog 的 MCP 诊断端口声明自己的意图、运行参数与用量快照，事件接收用本模块的', () => {
    const path = 'resource-catalog/application/ports/mcpDiagnosticExecution.ts'
    expect(exportedNames(path)).toEqual([
      'McpDiagnosticUsageModel',
      'McpDiagnosticUsageSnapshot',
      'McpDiagnosticObservation',
      'McpDiagnosticProfile',
      'McpDiagnosticIntent',
      'McpDiagnosticExecution',
      'McpDiagnosticExecutionFactory',
    ])
    const text = read(path)
    expect(text).toContain('readonly intent: McpDiagnosticIntent')
    expect(text).toContain('readonly eventSink: McpDiagnosticEventSink')
    expect(text).toContain('usage(snapshot: McpDiagnosticUsageSnapshot): Promise<void>')
  })

  test('托管诊断读的托管能力是本模块的形状', () => {
    const text = read('resource-catalog/infrastructure/crewstation/mcpDiagnosticsEffects.ts')
    expect(text).toContain('interface HostedDiagnosticCapabilities {')
    expect(text).toContain('readonly capabilities: () => Promise<HostedDiagnosticCapabilities>')
  })

  test('memory 的蒸馏端口从 task-execution 的系统代理运行合同上取词汇', () => {
    const text = read('memory/application/ports/distillWorkStore.ts')
    expect(text).toContain(
      "import type { SystemAgentRunRequest } from '@/modules/task-execution/public/participants'",
    )
    for (const line of [
      "type DistillRuntimeProtocol = SystemAgentRunRequest['protocol']",
      "type DistillRuntimeBinding = NonNullable<SystemAgentRunRequest['runtimeBinding']>",
      "export type SystemAgentEventSinkV1 = NonNullable<SystemAgentRunRequest['eventSink']>",
      "export type SessionCaptureTerminalState = Parameters<SystemAgentEventSinkV1['markTerminal']>[0]",
    ])
      expect([line, text.includes(line)]).toEqual([line, true])
    expect(text).toMatch(
      /type DistillRuntimeObservationIdentity = NonNullable<\s*SystemAgentRunRequest\['runtimeObservationIdentity'\]\s*>/,
    )
  })

  test('形状与 runtime-management 的合同对得上（编译期由 tsc 检查，这里留运行期锚点）', () => {
    for (const bind of [
      intentFits,
      diagnosticSinkFits,
      usageFits,
      usageArrives,
      capabilitiesArrive,
      distillSinkFits,
      distillSinkArrives,
      distillProtocolFits,
      distillIdentityFits,
      distillBindingFits,
    ])
      expect(typeof bind).toBe('function')
  })
})
