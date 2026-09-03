// RFC-294 review 2026-08-30 §B1 —— observed offered-consumption 边必须落在 design.md §3.1 的 DAG 里。
//
// 为什么存在（design/RFC-294-backend-layered-target-architecture/review-2026-08-30.md §B1）：
// `architecture/cross-context-imports.json` 把 TE→collaboration、TE→digital-employee、DE→TE、
// DA→TE 这些 design §3.1 明确不画的 offered 边记成 `role=offered-consumption`、
// `removeAfterWave=null`——即“目标态”；而 `rfc294-canonical-manifests.test.ts` 只做
// `targetEdges === TARGET_CONTEXT_EDGES`（常量对常量），从不检查 observed ⊆ target。
// 于是 DAG 只对自己成立，不对代码成立。
//
// 规则：每条跨 context 的 exact `public/*` 导入，其 (from → to) 必须是 design DAG 的 offered
// 边；另行分类的只有 identity-access type-only authority/context 边，以及 design §3.1 虚线
// 明列、按 provider 文件 + exact entrypoint + symbol + kind/syntax 收紧的 required-SPI implementation。
// DAG 外的存量边逐条入 `OFF_DAG_OFFERED_EDGE_DEBT`，只降不升，每条点名清偿波次；
// 边被删掉后必须同批销账（stale ⇒ 红）。
//
// 判据是 census.ts 的 AST import 边，与 canonical 生成器同一份实现。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import ts from 'typescript'

import {
  PUBLIC_ENTRYPOINTS,
  backendUnits,
  importEdges,
  isModuleUnit,
  moduleLocation,
  sourceUnit,
  targetModule,
  type SourceUnit,
} from './census'
import { TARGET_CONTEXT_EDGES } from './rfc294Canonical'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

export interface OffDagOfferedEdge {
  readonly from: string
  readonly fromContext: string
  readonly toContext: string
  readonly specifier: string
  readonly edgeKind: 'type' | 'value'
  readonly importedSymbols: readonly string[]
}

interface OfferedEdgeDebt {
  readonly from: string
  readonly to: string
  readonly why: string
  readonly removeAfterWave: string
}

export function offeredPairs(
  edges: ReadonlyArray<{
    readonly fromContext: string
    readonly toContext: string
    readonly role: string
  }>,
): ReadonlySet<string> {
  return new Set(
    edges
      .filter((edge) => edge.role === 'offered-consumption')
      .map((edge) => `${edge.fromContext}->${edge.toContext}`),
  )
}

const EXACT_PUBLIC = new Set<string>(PUBLIC_ENTRYPOINTS)

interface ExactRequiredSpiBinding {
  readonly from: string
  readonly specifier: string
  readonly symbol: string
  readonly edgeKind: 'type' | 'value'
  readonly syntax: 'export' | 'static-import'
  readonly role:
    | 'contract-resource-projection-spi'
    | 'workgroup-host-ledger-provider'
    | 'workgroup-task-room-provider'
    | 'workgroup-turns-provider'
}

interface NamedModuleBinding {
  readonly specifier: string
  readonly symbol: string
  readonly edgeKind: 'type' | 'value'
  readonly syntax: 'export' | 'static-import'
}

/**
 * Required-SPI provider implementations point from the provider context to a
 * consumer-owned public contract. They are not offered consumption, even
 * though both classes use an exact public import in source.
 *
 * Keep this list binding-exact. In particular, RC's room projection consumes
 * the two Workgroup node constants as ordinary offered data and is deliberately
 * absent. A file, entrypoint, symbol, kind, or syntax change therefore becomes
 * an ordinary off-DAG edge until its provider role is reviewed explicitly.
 */
const EXACT_REQUIRED_SPI_BINDINGS: readonly ExactRequiredSpiBinding[] = [
  ...([
    ['WORKGROUP_TURN_LEADER_NODE_ID', 'value'],
    ['WORKGROUP_TURN_MEMBER_NODE_ID', 'value'],
    ['WorkgroupHostLedgerMintOperation', 'type'],
    ['WorkgroupHostLedgerMintReceipt', 'type'],
    ['WorkgroupHostLedgerRun', 'type'],
    ['WorkgroupHostLedgerStampOperation', 'type'],
    ['WorkgroupTurnHostOperations', 'type'],
    ['WorkgroupTurnHostResult', 'type'],
    ['WorkgroupTurnLogger', 'type'],
    ['WorkgroupTurnsOperations', 'type'],
  ] as const).map(([symbol, edgeKind]) => ({
    from: 'packages/backend/src/modules/resource-catalog/application/workgroups/workgroupTurnsDriver.ts',
    specifier: '@/modules/task-execution/public/commands',
    symbol,
    edgeKind,
    syntax: 'static-import' as const,
    role: 'workgroup-turns-provider' as const,
  })),
  ...['WORKGROUP_TURN_LEADER_NODE_ID', 'WORKGROUP_TURN_MEMBER_NODE_ID'].map((symbol) => ({
    from: 'packages/backend/src/modules/resource-catalog/application/workgroups/workgroupTurnsDriver.ts',
    specifier: '@/modules/task-execution/public/commands',
    symbol,
    edgeKind: 'value' as const,
    syntax: 'export' as const,
    role: 'workgroup-turns-provider' as const,
  })),
  ...[
    'WorkgroupHostLedgerOperation',
    'WorkgroupHostLedgerParticipantInTx',
    'WorkgroupTurnsOperations',
  ].map((symbol) => ({
    from: 'packages/backend/src/modules/resource-catalog/infrastructure/postgresqlWorkgroupTurnsOperations.ts',
    specifier: '@/modules/task-execution/public/commands',
    symbol,
    edgeKind: 'type' as const,
    syntax: 'static-import' as const,
    role:
      symbol === 'WorkgroupTurnsOperations'
        ? ('workgroup-turns-provider' as const)
        : ('workgroup-host-ledger-provider' as const),
  })),
  ...['WorkgroupTaskRoomEventIdentity', 'WorkgroupTaskRoomTaskParticipantInTx'].map(
    (symbol) => ({
      from: 'packages/backend/src/modules/resource-catalog/infrastructure/postgresqlWorkgroupTaskRoom.ts',
      specifier: '@/modules/task-execution/public/commands',
      symbol,
      edgeKind: 'type' as const,
      syntax: 'static-import' as const,
      role: 'workgroup-task-room-provider' as const,
    }),
  ),
  {
    from: 'packages/backend/src/modules/resource-catalog/composition/workgroupTurns.ts',
    specifier: '@/modules/task-execution/public/commands',
    symbol: 'WorkgroupTurnsOperations',
    edgeKind: 'type',
    syntax: 'static-import',
    role: 'workgroup-turns-provider',
  },
  ...[
    'packages/backend/src/modules/resource-catalog/application/agents/digitalEmployeeAgentTemplateCatalog.ts',
    'packages/backend/src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms.ts',
    'packages/backend/src/modules/resource-catalog/infrastructure/legacy/agent.ts',
  ].flatMap((from) =>
    [
      'reconcileCreatedAgentExecutionContractPorts',
      'reconcileUpdatedAgentExecutionContractPorts',
    ].map((symbol) => ({
      from,
      specifier: '@/modules/execution-contract/public/commands',
      symbol,
      edgeKind: 'value' as const,
      syntax: 'static-import' as const,
      role: 'contract-resource-projection-spi' as const,
    })),
  ),
]

function requiredSpiBindingKey(binding: {
  readonly from: string
  readonly specifier: string
  readonly symbol: string
  readonly edgeKind: string
  readonly syntax: string
}): string {
  return [
    binding.from,
    binding.specifier,
    binding.symbol,
    binding.edgeKind,
    binding.syntax,
  ].join('|')
}

const EXACT_REQUIRED_SPI_BINDING_ROLES = new Map(
  EXACT_REQUIRED_SPI_BINDINGS.map((binding) => [requiredSpiBindingKey(binding), binding.role]),
)

/** Named static import/export bindings; default, namespace and star are sentinels and never exempt. */
function namedModuleBindings(unit: SourceUnit): NamedModuleBinding[] {
  const out: NamedModuleBinding[] = []
  for (const node of unit.source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      const clause = node.importClause
      if (clause === undefined) {
        out.push({ specifier, symbol: '<side-effect>', edgeKind: 'value', syntax: 'static-import' })
        continue
      }
      if (clause.name !== undefined) {
        out.push({
          specifier,
          symbol: '<default>',
          edgeKind: clause.isTypeOnly ? 'type' : 'value',
          syntax: 'static-import',
        })
      }
      const bindings = clause.namedBindings
      if (bindings === undefined) continue
      if (ts.isNamespaceImport(bindings)) {
        out.push({
          specifier,
          symbol: '<namespace>',
          edgeKind: clause.isTypeOnly ? 'type' : 'value',
          syntax: 'static-import',
        })
        continue
      }
      for (const element of bindings.elements) {
        out.push({
          specifier,
          symbol: (element.propertyName ?? element.name).text,
          edgeKind: clause.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
          syntax: 'static-import',
        })
      }
      continue
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text
      if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) {
        out.push({
          specifier,
          symbol: '<namespace>',
          edgeKind: node.isTypeOnly ? 'type' : 'value',
          syntax: 'export',
        })
        continue
      }
      for (const element of node.exportClause.elements) {
        out.push({
          specifier,
          symbol: (element.propertyName ?? element.name).text,
          edgeKind: node.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
          syntax: 'export',
        })
      }
    }
  }
  return out
}

function exactRequiredSpiProviderImplementation(
  unit: SourceUnit,
  edge: ReturnType<typeof importEdges>[number],
  bindings: readonly NamedModuleBinding[],
): boolean {
  if (edge.syntax !== 'static-import' && edge.syntax !== 'export') return false
  const matching = bindings.filter(
    (binding) =>
      binding.specifier === edge.specifier &&
      binding.edgeKind === edge.kind &&
      binding.syntax === edge.syntax,
  )
  return (
    matching.length > 0 &&
    matching.every((binding) =>
      EXACT_REQUIRED_SPI_BINDING_ROLES.has(
        requiredSpiBindingKey({
          from: unit.path,
          ...binding,
        }),
      ),
    )
  )
}

/** identity-access 的 type-only authority/context 边：所有含 command/query 的 context 都允许。 */
function isAuthorityTypeOnly(toContext: string, entry: string, edgeKind: string): boolean {
  return (
    toContext === 'identity-access' &&
    edgeKind === 'type' &&
    (entry === 'types' || entry === 'participants')
  )
}

export function offDagOfferedEdges(
  units: readonly SourceUnit[],
  pairs: ReadonlySet<string>,
): OffDagOfferedEdge[] {
  const out: OffDagOfferedEdge[] = []
  for (const unit of units) {
    const from = moduleLocation(unit.path)
    if (from === null) continue
    const namedBindings = namedModuleBindings(unit)
    for (const edge of importEdges(unit)) {
      const to = targetModule(edge)
      if (to === null || to.context === from.context) continue
      const parts = to.rest.split('/')
      if (parts.length !== 2 || parts[0] !== 'public') continue
      const entry = parts[1] ?? ''
      if (!EXACT_PUBLIC.has(entry)) continue
      if (isAuthorityTypeOnly(to.context, entry, edge.kind)) continue
      if (pairs.has(`${from.context}->${to.context}`)) continue
      if (exactRequiredSpiProviderImplementation(unit, edge, namedBindings)) continue
      out.push({
        from: unit.path,
        fromContext: from.context,
        toContext: to.context,
        specifier: edge.specifier,
        edgeKind: edge.kind,
        importedSymbols: namedBindings
          .filter(
            (binding) =>
              binding.specifier === edge.specifier &&
              binding.edgeKind === edge.kind &&
              binding.syntax === edge.syntax,
          )
          .map((binding) => binding.symbol)
          .sort(),
      })
    }
  }
  return out.sort((left, right) =>
    `${left.from}|${left.toContext}|${left.specifier}`.localeCompare(
      `${right.from}|${right.toContext}|${right.specifier}`,
    ),
  )
}

/**
 * 存量 DAG 外 offered 边（committed HEAD `625017c08`，review 2026-08-30 采样）。
 * 每条一个 `(from 文件, to context)`；只降不升。
 */
export const OFF_DAG_OFFERED_EDGE_DEBT: readonly OfferedEdgeDebt[] = [
  {
    "from": "packages/backend/src/modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts",
    "to": "memory",
    "why": "RFC-352 T2 把 `node_runs.injected_memories_json` 的解码器从 legacy `services/memoryInject.ts` 迁进 memory 并经 public/types 提供，于是这条本来就存在的依赖第一次以 offered 边出现在图里（此前是 legacy→legacy，不计跨域）。目标形态是 task-execution 经自己的 TaskMemoryInjectionPort 拿这份编解码，属 TE 侧 adapter 收口。",
    "removeAfterWave": "W4-E1（task-execution vertical slice：REST 投影改经 TaskMemoryInjectionPort）"
  },
  {
    "from": "packages/backend/src/modules/collaboration/application/taskFeedback.ts",
    "to": "memory",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/collaboration/infrastructure/legacySqliteClarify/autoDispatch.ts",
    "to": "memory",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/collaboration/infrastructure/legacySqliteClarifyDecisionComposition.ts",
    "to": "memory",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/collaboration/infrastructure/sqliteClarifyContinuationConvergence.ts",
    "to": "memory",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/collaboration/public/commands.ts",
    "to": "memory",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/digital-employee/application/adapters/task-execution-adapter.ts",
    "to": "task-execution",
    "why": "digital-employee adapter 直接 import task-execution `DigitalEmployeeExecutionParticipant`；design §3.1 已记为双向 contract debt，W4-E9 以 DE-owned `ReactionExecutionPortV1`/admission participant 收口后删除。",
    "removeAfterWave": "W4-E9"
  },
  {
    "from": "packages/backend/src/modules/intent/composition/platformInventory.ts",
    "to": "development-automation",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/intent/composition/platformInventory.ts",
    "to": "digital-employee",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/memory/application/distillQueries.ts",
    "to": "runtime-management",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/memory/application/ports/distillWorkStore.ts",
    "to": "runtime-management",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/resource-catalog/infrastructure/postgresqlAgentPersistenceSemantics.ts",
    "to": "execution-contract",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/source-control/application/ports/workspaceMaintenance.ts",
    "to": "task-execution",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/system-operations/application/overview.ts",
    "to": "integration",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/system-operations/application/overview.ts",
    "to": "resource-catalog",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/system-operations/application/overview.ts",
    "to": "source-control",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/system-operations/composition.ts",
    "to": "source-control",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/system-operations/public/queries.ts",
    "to": "task-execution",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/application/parkTaskAtHumanGate.ts",
    "to": "collaboration",
    "why": "task-execution 的 human-gate 命令/参与者引用 collaboration public 的 `PreparedHumanGateRef`/`HumanGateIdentity`；design §3.1 只画 COL→TE，required `HumanGateOpenParticipantInTx` 的输入类型应归 task-execution 所有、由 collaboration 实现。W4 collaboration public cutover 时归位后删除。",
    "removeAfterWave": "W4"
  },
  {
    "from": "packages/backend/src/modules/task-execution/application/ports/humanGateOpenParticipant.ts",
    "to": "collaboration",
    "why": "task-execution 的 human-gate 命令/参与者引用 collaboration public 的 `PreparedHumanGateRef`/`HumanGateIdentity`；design §3.1 只画 COL→TE，required `HumanGateOpenParticipantInTx` 的输入类型应归 task-execution 所有、由 collaboration 实现。W4 collaboration public cutover 时归位后删除。",
    "removeAfterWave": "W4"
  },
  {
    "from": "packages/backend/src/modules/task-execution/application/ports/humanGateTaskLifecycle.ts",
    "to": "collaboration",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog.ts",
    "to": "digital-employee",
    "why": "task-execution 消费 digital-employee public 的 `WorkspaceFailureClass`/platform tool catalog participant；design §3.1 记为双向 contract/type debt，W4-E9 改为两套 DE-owned required SPI 后删除。",
    "removeAfterWave": "W4-E9"
  },
  {
    "from": "packages/backend/src/modules/task-execution/composition/digitalEmployeeExecution.ts",
    "to": "digital-employee",
    "why": "task-execution 消费 digital-employee public 的 `WorkspaceFailureClass`/platform tool catalog participant；design §3.1 记为双向 contract/type debt，W4-E9 改为两套 DE-owned required SPI 后删除。",
    "removeAfterWave": "W4-E9"
  },
  {
    "from": "packages/backend/src/modules/task-execution/composition/humanGate.ts",
    "to": "collaboration",
    "why": "task-execution 的 human-gate 命令/参与者引用 collaboration public 的 `PreparedHumanGateRef`/`HumanGateIdentity`；design §3.1 只画 COL→TE，required `HumanGateOpenParticipantInTx` 的输入类型应归 task-execution 所有、由 collaboration 实现。W4 collaboration public cutover 时归位后删除。",
    "removeAfterWave": "W4"
  },
  {
    "from": "packages/backend/src/modules/task-execution/composition/nodeExecution.ts",
    "to": "collaboration",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/composition/nodeMechanics.ts",
    "to": "collaboration",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/composition/required-ports.ts",
    "to": "digital-employee",
    "why": "task-execution 消费 digital-employee public 的 `WorkspaceFailureClass`/platform tool catalog participant；design §3.1 记为双向 contract/type debt，W4-E9 改为两套 DE-owned required SPI 后删除。",
    "removeAfterWave": "W4-E9"
  },
  {
    "from": "packages/backend/src/modules/task-execution/composition/sqliteGateContinuationPreDrive.ts",
    "to": "memory",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/composition/taskClarifyDirectiveRoutes.ts",
    "to": "collaboration",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/composition/taskEngineRuntimeOptions.ts",
    "to": "collaboration",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/composition/taskEngineRuntimeOptions.ts",
    "to": "memory",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/infrastructure/postgresqlTaskExecutionRuntimeParticipants.ts",
    "to": "collaboration",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts",
    "to": "collaboration",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/infrastructure/postgresqlTaskRouteRepairOperations.ts",
    "to": "collaboration",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/infrastructure/sqliteTaskExecutionRuntimeParticipants.ts",
    "to": "collaboration",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/infrastructure/sqliteTaskExecutionRuntimeParticipants.ts",
    "to": "memory",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/infrastructure/sqliteTaskParkTransaction.ts",
    "to": "collaboration",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/infrastructure/sqliteTaskRouteOperations.ts",
    "to": "collaboration",
    "why": "RFC-349 provider cutover 新增了 owner-closed public participant 消费，但该 bounded-context 对尚未进入 design §3.1 目标 DAG；先逐文件精确锁定，待 ownership/DAG 正式收敛后销账。",
    "removeAfterWave": "W4-E（RFC-294 provider-neutral bounded-context convergence）"
  },
  {
    "from": "packages/backend/src/modules/task-execution/public/participants.ts",
    "to": "digital-employee",
    "why": "task-execution 消费 digital-employee public 的 `WorkspaceFailureClass`/platform tool catalog participant；design §3.1 记为双向 contract/type debt，W4-E9 改为两套 DE-owned required SPI 后删除。",
    "removeAfterWave": "W4-E9"
  }
]

const PAIRS = offeredPairs(TARGET_CONTEXT_EDGES)
const UNITS = backendUnits(REPO_ROOT).filter(isModuleUnit)

describe('RFC-294 review §B1 —— observed offered 边 ⊆ design §3.1 DAG', () => {
  test('语料下限：确实扫到了 modules/** 生产源码', () => {
    expect(UNITS.length).toBeGreaterThanOrEqual(300)
  })

  test('DAG 外的 offered 边与债务账本逐条相等（新增 ⇒ 红；边已删不销账 ⇒ 红）', () => {
    const observed = [
      ...new Set(offDagOfferedEdges(UNITS, PAIRS).map((edge) => `${edge.from}|${edge.toContext}`)),
    ].sort()
    const ledger = OFF_DAG_OFFERED_EDGE_DEBT.map((entry) => `${entry.from}|${entry.to}`).sort()
    const unlisted = observed.filter((key) => !ledger.includes(key))
    const stale = ledger.filter((key) => !observed.includes(key))
    expect(
      unlisted,
      'design §3.1 DAG 之外的 offered public 导入：要么补 DAG（改 design.md §3.1 与 TARGET_CONTEXT_EDGES），' +
        '要么入 OFF_DAG_OFFERED_EDGE_DEBT 并点名清偿波次',
    ).toEqual([])
    expect(stale, '账本条目对应的边已不存在：同批删掉该条').toEqual([])
  })

  test('每条债务都点名清偿波次与理由', () => {
    const bad = OFF_DAG_OFFERED_EDGE_DEBT.filter(
      (entry) => !/^W\d/.test(entry.removeAfterWave) || entry.why.trim().length < 20,
    ).map((entry) => `${entry.from}|${entry.to}`)
    expect(bad).toEqual([])
  })
})

describe('RFC-294 review §B1 —— 负 fixture：判据自己咬得动', () => {
  test('只把 exact RC→TE / RC→XC provider binding 分类为 required-SPI implementation', () => {
    expect(
      offDagOfferedEdges(
        [
          sourceUnit(
            'packages/backend/src/modules/resource-catalog/application/workgroups/workgroupTurnsDriver.ts',
            `
              import {
                WORKGROUP_TURN_LEADER_NODE_ID,
                type WorkgroupTurnsOperations,
              } from '@/modules/task-execution/public/commands'
            `,
          ),
          sourceUnit(
            'packages/backend/src/modules/resource-catalog/infrastructure/postgresqlWorkgroupTurnsOperations.ts',
            `
              import type {
                WorkgroupHostLedgerParticipantInTx,
                WorkgroupTurnsOperations,
              } from '@/modules/task-execution/public/commands'
            `,
          ),
          sourceUnit(
            'packages/backend/src/modules/resource-catalog/application/agents/digitalEmployeeAgentTemplateCatalog.ts',
            `
              import {
                reconcileCreatedAgentExecutionContractPorts,
                reconcileUpdatedAgentExecutionContractPorts,
              } from '@/modules/execution-contract/public/commands'
            `,
          ),
        ],
        PAIRS,
      ),
    ).toEqual([])
  })

  test('required-SPI 分类不放行错文件、错 symbol、错 entrypoint 或错 syntax', () => {
    const violations = offDagOfferedEdges(
      [
        sourceUnit(
          'packages/backend/src/modules/resource-catalog/application/workgroups/workgroupRoomProjection.ts',
          `
            import {
              WORKGROUP_TURN_LEADER_NODE_ID,
              WORKGROUP_TURN_MEMBER_NODE_ID,
            } from '@/modules/task-execution/public/commands'
          `,
        ),
        sourceUnit(
          'packages/backend/src/modules/resource-catalog/composition/workgroupTurns.ts',
          `
            import type {
              TaskRecoveryOperations,
              WorkgroupTurnsOperations,
            } from '@/modules/task-execution/public/commands'
          `,
        ),
        sourceUnit(
          'packages/backend/src/modules/resource-catalog/infrastructure/postgresqlWorkgroupTurnsOperations.ts',
          "import type { WorkgroupTurnsOperations } from '@/modules/task-execution/public/queries'\n",
        ),
        sourceUnit(
          'packages/backend/src/modules/resource-catalog/composition/workgroupTurns.ts',
          "export type { WorkgroupTurnsOperations } from '@/modules/task-execution/public/commands'\n",
        ),
        sourceUnit(
          'packages/backend/src/modules/resource-catalog/composition/workgroupTurns.ts',
          "import { WorkgroupTurnsOperations } from '@/modules/task-execution/public/commands'\n",
        ),
        sourceUnit(
          'packages/backend/src/modules/resource-catalog/application/agents/agentApplication.ts',
          `
            import { reconcileCreatedAgentExecutionContractPorts }
              from '@/modules/execution-contract/public/commands'
          `,
        ),
      ],
      PAIRS,
    )
    expect(violations).toHaveLength(6)
    expect(violations.map((edge) => `${edge.from}|${edge.specifier}`)).toEqual([
      'packages/backend/src/modules/resource-catalog/application/agents/agentApplication.ts|@/modules/execution-contract/public/commands',
      'packages/backend/src/modules/resource-catalog/application/workgroups/workgroupRoomProjection.ts|@/modules/task-execution/public/commands',
      'packages/backend/src/modules/resource-catalog/composition/workgroupTurns.ts|@/modules/task-execution/public/commands',
      'packages/backend/src/modules/resource-catalog/composition/workgroupTurns.ts|@/modules/task-execution/public/commands',
      'packages/backend/src/modules/resource-catalog/composition/workgroupTurns.ts|@/modules/task-execution/public/commands',
      'packages/backend/src/modules/resource-catalog/infrastructure/postgresqlWorkgroupTurnsOperations.ts|@/modules/task-execution/public/queries',
    ])
    expect(violations.flatMap((edge) => edge.importedSymbols)).toContain('TaskRecoveryOperations')
  })

  test('DAG 外的 public 导入会被报', () => {
    expect(
      offDagOfferedEdges(
        [
          sourceUnit(
            'packages/backend/src/modules/task-execution/application/probe.ts',
            "import type { HumanGateIdentity } from '@/modules/collaboration/public/types'\n",
          ),
        ],
        PAIRS,
      ).map((edge) => edge.toContext),
    ).toEqual(['collaboration'])
  })

  test('DAG 内的边、identity-access type-only 边、非 exact public 深层导入都不报', () => {
    expect(
      offDagOfferedEdges(
        [
          sourceUnit(
            'packages/backend/src/modules/collaboration/application/probe.ts',
            "import type { TaskExecutionReadModels } from '@/modules/task-execution/public/types'\n",
          ),
          sourceUnit(
            'packages/backend/src/modules/resource-catalog/public/probe.ts',
            "import type { QueryContext } from '@/modules/identity-access/public/participants'\n",
          ),
          sourceUnit(
            'packages/backend/src/modules/integration/application/probe.ts',
            "import { x } from '@/modules/task-execution/composition/sourceTermination'\n",
          ),
        ],
        PAIRS,
      ),
    ).toEqual([])
  })

  test('value 形态的 identity-access participants 导入不享受 type-only 豁免', () => {
    expect(
      offDagOfferedEdges(
        [
          sourceUnit(
            'packages/backend/src/modules/resource-catalog/application/probe.ts',
            "import { resolveAuthority } from '@/modules/identity-access/public/participants'\n",
          ),
        ],
        PAIRS,
      ).map((edge) => edge.edgeKind),
    ).toEqual(['value'])
  })
})
