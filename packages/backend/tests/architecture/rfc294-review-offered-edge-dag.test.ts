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
// 边；唯一例外是 identity-access 的 type-only authority/context 边（§3.1 type-only matrix 与散文
// 「对 identity-access/public/participants 只按实际 consumer 取 context/delegated resolver」）。
// DAG 外的存量边逐条入 `OFF_DAG_OFFERED_EDGE_DEBT`，只降不升，每条点名清偿波次；
// 边被删掉后必须同批销账（stale ⇒ 红）。
//
// 判据是 census.ts 的 AST import 边，与 canonical 生成器同一份实现。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

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
    for (const edge of importEdges(unit)) {
      const to = targetModule(edge)
      if (to === null || to.context === from.context) continue
      const parts = to.rest.split('/')
      if (parts.length !== 2 || parts[0] !== 'public') continue
      const entry = parts[1] ?? ''
      if (!EXACT_PUBLIC.has(entry)) continue
      if (isAuthorityTypeOnly(to.context, entry, edge.kind)) continue
      if (pairs.has(`${from.context}->${to.context}`)) continue
      out.push({
        from: unit.path,
        fromContext: from.context,
        toContext: to.context,
        specifier: edge.specifier,
        edgeKind: edge.kind,
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
    from: 'packages/backend/src/modules/digital-employee/application/adapters/task-execution-adapter.ts',
    to: 'task-execution',
    why: 'digital-employee adapter 直接 import task-execution `DigitalEmployeeExecutionParticipant`；design §3.1 已记为双向 contract debt，W4-E9 以 DE-owned `ReactionExecutionPortV1`/admission participant 收口后删除。',
    removeAfterWave: 'W4-E9',
  },
  {
    from: 'packages/backend/src/modules/task-execution/application/acceptHumanGateDecision.ts',
    to: 'collaboration',
    why: 'task-execution 的 human-gate 命令/参与者引用 collaboration public 的 `PreparedHumanGateRef`/`HumanGateIdentity`；design §3.1 只画 COL→TE，required `HumanGateOpenParticipantInTx` 的输入类型应归 task-execution 所有、由 collaboration 实现。W4 collaboration public cutover 时归位后删除。',
    removeAfterWave: 'W4',
  },
  {
    from: 'packages/backend/src/modules/task-execution/application/parkTaskAtHumanGate.ts',
    to: 'collaboration',
    why: 'task-execution 的 human-gate 命令/参与者引用 collaboration public 的 `PreparedHumanGateRef`/`HumanGateIdentity`；design §3.1 只画 COL→TE，required `HumanGateOpenParticipantInTx` 的输入类型应归 task-execution 所有、由 collaboration 实现。W4 collaboration public cutover 时归位后删除。',
    removeAfterWave: 'W4',
  },
  {
    from: 'packages/backend/src/modules/task-execution/application/ports/humanGateOpenParticipant.ts',
    to: 'collaboration',
    why: 'task-execution 的 human-gate 命令/参与者引用 collaboration public 的 `PreparedHumanGateRef`/`HumanGateIdentity`；design §3.1 只画 COL→TE，required `HumanGateOpenParticipantInTx` 的输入类型应归 task-execution 所有、由 collaboration 实现。W4 collaboration public cutover 时归位后删除。',
    removeAfterWave: 'W4',
  },
  {
    from: 'packages/backend/src/modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog.ts',
    to: 'digital-employee',
    why: 'task-execution 消费 digital-employee public 的 `WorkspaceFailureClass`/platform tool catalog participant；design §3.1 记为双向 contract/type debt，W4-E9 改为两套 DE-owned required SPI 后删除。',
    removeAfterWave: 'W4-E9',
  },
  {
    from: 'packages/backend/src/modules/task-execution/composition/digitalEmployeeExecution.ts',
    to: 'digital-employee',
    why: 'task-execution 消费 digital-employee public 的 `WorkspaceFailureClass`/platform tool catalog participant；design §3.1 记为双向 contract/type debt，W4-E9 改为两套 DE-owned required SPI 后删除。',
    removeAfterWave: 'W4-E9',
  },
  {
    from: 'packages/backend/src/modules/task-execution/composition/humanGate.ts',
    to: 'collaboration',
    why: 'task-execution 的 human-gate 命令/参与者引用 collaboration public 的 `PreparedHumanGateRef`/`HumanGateIdentity`；design §3.1 只画 COL→TE，required `HumanGateOpenParticipantInTx` 的输入类型应归 task-execution 所有、由 collaboration 实现。W4 collaboration public cutover 时归位后删除。',
    removeAfterWave: 'W4',
  },
  {
    from: 'packages/backend/src/modules/task-execution/composition/required-ports.ts',
    to: 'digital-employee',
    why: 'task-execution 消费 digital-employee public 的 `WorkspaceFailureClass`/platform tool catalog participant；design §3.1 记为双向 contract/type debt，W4-E9 改为两套 DE-owned required SPI 后删除。',
    removeAfterWave: 'W4-E9',
  },
  {
    from: 'packages/backend/src/modules/task-execution/public/participants.ts',
    to: 'digital-employee',
    why: 'task-execution 消费 digital-employee public 的 `WorkspaceFailureClass`/platform tool catalog participant；design §3.1 记为双向 contract/type debt，W4-E9 改为两套 DE-owned required SPI 后删除。',
    removeAfterWave: 'W4-E9',
  },
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
