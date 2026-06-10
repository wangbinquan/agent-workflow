// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-12 (WP-2)
//
// 当前缺陷行为：deriveFrontier 的分桶循环（scheduler.ts:1108-1133）对 NodeRunStatus
// 不穷举——latest 行为 running / canceled / skipped 时：isDispatchable
// （dispatchFrontier.ts:156-157）返回 false ⇒ 不 ready；分桶只枚举
// awaiting_review / awaiting_human / failed（scheduler.ts:1129-1132）⇒ 不落任何桶；
// 不 completed ⇒ allSettled=false。三者皆"无桶黑洞"：scope 静默后 runScope
// （scheduler.ts:675-678）以不含 nodeId 的 `scheduler stalled` 假失败收场。
// 历史已五连漏（awaiting_*、exhausted、interrupted、canceled，其中三例发生在
// RFC-053 状态机化之后，5dad31b 一次修三桶）——人工枚举确证挡不住。
// 'skipped' 在 schema 存在但全 src 零 mint 点，未来任何人启用即落黑洞。
//
// 正确语义（修复方向，见报告建议修法）：分桶做成对 NodeRunStatus 全集的穷举
// （switch + never），每个状态值入且仅入一个显式集合；running 黑洞的现实来源
// （遗弃 running 行）与 canceled 的"可恢复终态 vs 真终态"归类（S-22）都要获得
// 显式决策；stalled 错误附带阻塞节点清单。
//
// 修复落点：WP-2（decideScopeOutcome 抽取 + 状态宇宙穷举）。修复时本文件应翻红：
// 把 EXPECTED 表里 'black-hole' 的三行改成修复决策出的显式桶/信号即可转绿。
//
// 本文件的存在性双保险：EXPECTED 表与 shared 的 NODE_RUN_STATUS 全集做键集相等
// 断言——未来给 NodeRunStatus 加新值时本测试自然翻红，强迫新状态先过分桶决策。
//
// 注：exhausted 的深组合（下游 hold / resume 路径）已被
// tests/derive-frontier-exhausted.test.ts 覆盖，此处仅保留全集扫描所需的单行。
// 纯函数直测；row()/def() 帮手复刻自 derive-frontier.test.ts（file-local，不改既有文件）。
//
// RFC-092 更新（design/RFC-092-scheduler-p0-stopgap/design.md §1.2）：pending 行的
// 语义升级为 pending-anchor bypass —— EXPECTED 表的 pending 行（dedup 集为空）维持
// 'ready' 不变；新增补充表项覆盖「pending ∈ dispatchedThisInvocation」组合：
//   - 行 id ∉ dispatchedPendingRowIds（第 11 参，空集）→ ready（按行 id 一次性豁免）；
//   - 行 id ∈ dispatchedPendingRowIds → 无桶（有界退化 = stall 语义，防 busy-loop）。
// running / canceled / skipped 的黑洞行仍是 CURRENT-BEHAVIOR LOCK，归 WP-2
// （decideScopeOutcome 抽取 + 状态宇宙穷举），不在 RFC-092 范围。

import { describe, expect, test } from 'bun:test'
import { NODE_RUN_STATUS, type NodeRunStatus } from '@agent-workflow/shared'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'
import type { nodeRuns } from '../src/db/schema'
import { isDispatchable } from '../src/services/dispatchFrontier'
import { deriveFrontier } from '../src/services/scheduler'

type Row = typeof nodeRuns.$inferSelect
type WorkflowNode = WorkflowDefinition['nodes'][number]
const NONE: ReadonlySet<string> = new Set()

let seq = 0
function row(nodeId: string, status: string, over: Partial<Row> = {}): Row {
  seq += 1
  return {
    id: `01R${String(seq).padStart(4, '0')}`,
    nodeId,
    iteration: 0,
    status,
    parentNodeRunId: null,
    consumedUpstreamRunsJson: null,
    wrapperProgressJson: null,
    ...over,
  } as unknown as Row
}

function def(nodes: Array<{ id: string; kind: NodeKind }>): {
  definition: WorkflowDefinition
  scopeNodes: WorkflowNode[]
  scopeIds: Set<string>
} {
  const definition = { nodes, edges: [] } as unknown as WorkflowDefinition
  return {
    definition,
    scopeNodes: nodes as unknown as WorkflowNode[],
    scopeIds: new Set(nodes.map((n) => n.id)),
  }
}

/** 一个状态值在 Frontier 里的归宿。 */
type Bucket =
  | 'completed'
  | 'ready'
  | 'awaitingReview'
  | 'awaitingHuman'
  | 'failed'
  | 'exhausted'
  | 'black-hole'

// 状态 → (语义上会持有该状态的节点 kind, 当前归宿)。
// inFlight=NONE：表驱动建模的是"无人在飞"的静默 tick——running 即遗弃 running 行
// （runTask sink/wrapper 分支抛错后行停在 running，scheduler.ts:353-359 注释自认）。
const EXPECTED: Record<NodeRunStatus, { kind: NodeKind; bucket: Bucket }> = {
  // RFC-092 §1.2：out-of-band mint / placeholder —— pending-anchor bypass 放行。
  // dedup 集为空时 ready（本表行）；∈ dispatchedThisInvocation 的组合见下方补充表项
  // （空 dispatchedPendingRowIds → ready；行 id ∈ dispatchedPendingRowIds → 无桶，有界退化）。
  pending: { kind: 'agent-single', bucket: 'ready' },
  // DEFECT(S-12): 遗弃 running 行既不 ready 也无桶。FLIP on fix → 显式桶/重铸信号。
  running: { kind: 'agent-single', bucket: 'black-hole' },
  done: { kind: 'agent-single', bucket: 'completed' }, // done ∧ fresh（无 consumed ⇒ fresh）
  failed: { kind: 'agent-single', bucket: 'ready' }, // N1 resume/retry 重铸信号
  // DEFECT(S-12/S-22): canceled 无桶 ⇒ retryNode 后 scope 永 stalled。FLIP on fix。
  canceled: { kind: 'agent-single', bucket: 'black-hole' },
  interrupted: { kind: 'agent-single', bucket: 'ready' }, // daemon-restart 重铸信号
  // DEFECT(S-12): schema 有值、全 src 零 mint 点；谁先启用谁踩黑洞。FLIP on fix。
  skipped: { kind: 'agent-single', bucket: 'black-hole' },
  exhausted: { kind: 'wrapper-loop', bucket: 'exhausted' }, // loop-max 真终态（深组合见 derive-frontier-exhausted.test.ts）
  awaiting_review: { kind: 'review', bucket: 'awaitingReview' }, // fresh parked leaf 保持 park（C2）
  awaiting_human: { kind: 'clarify', bucket: 'awaitingHuman' },
}

/** 跑一个单节点 scope，返回该节点落入的桶（入多桶则抛错——分桶互斥也是契约）。 */
function classify(status: NodeRunStatus, kind: NodeKind): Bucket {
  const { definition, scopeNodes, scopeIds } = def([{ id: 'n', kind }])
  const f = deriveFrontier(
    [row('n', status)],
    definition,
    scopeNodes,
    scopeIds,
    0,
    new Map(),
    NONE, // inFlight 空：遗弃行场景
    NONE, // dispatchedThisInvocation 空：排除 S-1 的去重干扰
    NONE,
  )
  const hits: Bucket[] = []
  if (f.completed.has('n')) hits.push('completed')
  if (f.ready.includes('n')) hits.push('ready')
  if (f.awaitingReview.includes('n')) hits.push('awaitingReview')
  if (f.awaitingHuman.includes('n')) hits.push('awaitingHuman')
  if (f.failed.includes('n')) hits.push('failed')
  if (f.exhausted.includes('n')) hits.push('exhausted')
  if (hits.length > 1)
    throw new Error(`status '${status}' fell into multiple buckets: ${hits.join(',')}`)
  return hits[0] ?? 'black-hole'
}

describe('S-12 — deriveFrontier 状态分桶全集扫描（黑洞现状锁定）', () => {
  test('EXPECTED 表覆盖 NODE_RUN_STATUS 全集（新增状态值 ⇒ 此断言翻红，强迫先过分桶决策）', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...NODE_RUN_STATUS].sort())
  })

  for (const status of NODE_RUN_STATUS) {
    const { kind, bucket } = EXPECTED[status]
    test(`latest='${status}' (kind=${kind}) → ${bucket === 'black-hole' ? '无桶黑洞（DEFECT，修复时翻转）' : `'${bucket}'`}`, () => {
      expect(classify(status, kind)).toBe(bucket)
    })
  }

  test('黑洞三状态 ⇒ allSettled=false 且 Frontier 五出口全空 —— runScope 静默块唯一对应 "scheduler stalled" 兜底', () => {
    for (const status of ['running', 'canceled', 'skipped'] as const) {
      const { definition, scopeNodes, scopeIds } = def([{ id: 'n', kind: 'agent-single' }])
      const f = deriveFrontier(
        [row('n', status)],
        definition,
        scopeNodes,
        scopeIds,
        0,
        new Map(),
        NONE,
        NONE,
        NONE,
      )
      // FLIP on fix: 每个黑洞状态获得显式桶/信号后，对应 status 从这组断言里移除。
      expect(f.ready).toEqual([])
      expect(f.awaitingHuman).toEqual([])
      expect(f.awaitingReview).toEqual([])
      expect(f.failed).toEqual([])
      expect(f.exhausted).toEqual([])
      expect(f.allSettled).toBe(false)
    }
  })

  // RFC-092 补充表项（EXPECTED 表按 status 单行建模、表不下这组组合，故独立成 case）：
  // pending ∈ dispatchedThisInvocation 时的两种归宿 —— 行 id 一次性豁免的两侧。
  test('RFC-092：pending ∈ dispatchedThisInvocation + 空 dispatchedPendingRowIds → ready（anchor 暴露）；行 id ∈ dispatchedPendingRowIds → 无桶（有界退化）', () => {
    const { definition, scopeNodes, scopeIds } = def([{ id: 'n', kind: 'agent-single' }])
    const r = row('n', 'pending')
    const dispatched = new Set(['n'])
    // 侧 1：行尚未豁免过 → pending-anchor bypass 绕过节点级去重放行。
    const released = deriveFrontier(
      [r],
      definition,
      scopeNodes,
      scopeIds,
      0,
      new Map(),
      NONE,
      dispatched,
      NONE,
      NONE,
      NONE,
    )
    expect(released.ready).toEqual(['n'])
    expect(released.pendingAnchors.get('n')).toBe(r.id)
    // 侧 2：同一行 id 已豁免过 → 不 ready、不入任何桶（= stall 语义，防 busy-loop）。
    const bounded = deriveFrontier(
      [r],
      definition,
      scopeNodes,
      scopeIds,
      0,
      new Map(),
      NONE,
      dispatched,
      NONE,
      NONE,
      new Set([r.id]),
    )
    expect(bounded.ready).toEqual([])
    expect(bounded.pendingAnchors.size).toBe(0)
    expect(bounded.awaitingHuman).toEqual([])
    expect(bounded.awaitingReview).toEqual([])
    expect(bounded.failed).toEqual([])
    expect(bounded.exhausted).toEqual([])
    expect(bounded.allSettled).toBe(false)
  })

  test("isDispatchable('skipped') → false（dispatch-frontier.test.ts 唯一未覆盖的状态值；canceled/running 已被其覆盖）", () => {
    // 与 deriveFrontier 表的 skipped 行互为印证：gate 拒绝 + 分桶不收 = 黑洞。
    const r = row('n', 'skipped')
    expect(
      isDispatchable(r, 'agent-single', new Map(), [r], {
        nodes: [],
        edges: [],
      } as unknown as WorkflowDefinition),
    ).toBe(false)
  })

  test('黑洞节点同时卡死下游：canceled 上游 ⇒ 下游永不 ready（S-22 场景的最小形态）', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'up', kind: 'agent-single' },
      { id: 'down', kind: 'agent-single' },
    ])
    const f = deriveFrontier(
      [row('up', 'canceled')],
      definition,
      scopeNodes,
      scopeIds,
      0,
      new Map([['down', ['up']]]),
      NONE,
      NONE,
      NONE,
    )
    expect(f.ready).toEqual([])
    expect(f.allSettled).toBe(false)
  })
})
