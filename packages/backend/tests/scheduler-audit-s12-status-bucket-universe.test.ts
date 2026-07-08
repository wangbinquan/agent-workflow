// RFC-095 SEMANTICS LOCK — deriveFrontier 状态分桶全集穷举（audit S-12 / S-22，WP-2 落地）
//
// 来历：design/scheduler-audit-2026-06-10.md S-12 曾以 CURRENT-BEHAVIOR LOCK 锁定
// 三个"无桶黑洞"——latest 行为 running / canceled / skipped 时既不 ready 也不入任何
// 桶，scope 静默后 runScope 只能以不含 nodeId 的裸 `scheduler stalled` 假失败收场
// （历史五连漏：awaiting_*、exhausted、interrupted、canceled，人工枚举确证挡不住）。
// RFC-095（design/RFC-095-scope-outcome-exhaustive/design.md §2.2）把分桶改成对
// NodeRunStatus 全集的双层穷举 switch + assertNever，并新增 Frontier.blocked 诊断
// 出口；本文件随之翻转为正确语义锁定：
//
//   - canceled（无 supersede 标记）→ ready（S-22：复活信号，与 interrupted 同类；
//     task cancel 保留 worktree，retryNode 复活是设计内 UI 流）。
//   - canceled + superseded_by_review 列非空（RFC-145 列化）→ blocked
//     ('review-superseded')：submitReviewDecision 先翻旧行再铸 pending rerun，
//     窗口内派发会让 agent 丢失 review 上下文——标记行永久停泊，rerun 行承载复活。
//   - running（不在飞）→ blocked('orphaned-running-row' 前缀)：遗弃 running 行
//     获得显式诊断（重启 daemon 收割）而非静默 stall。
//   - skipped → blocked('skipped-has-no-dispatch-semantics')：schema 有值、全 src
//     零 mint 点；谁启用谁先过 isDispatchable 的显式 case 决策。
//   - pending ∈ dispatchedPendingRowIds（RFC-092 锚已耗，第 11 参）→ blocked
//     ('pending-anchor-consumed')：有界退化从"无桶"升级为可诊断（见
//     design/RFC-092-scheduler-p0-stopgap/design.md §1.2；dedup 集为空时仍 ready）。
//   - 其余状态归类不变：pending / failed / interrupted → ready（重铸信号）；
//     done ∧ fresh → completed；exhausted / awaiting_* → 各自停泊桶。
//
// 表驱动卖点保留：EXPECTED 表与 shared 的 NODE_RUN_STATUS 全集做键集相等断言——
// 未来给 NodeRunStatus 加新值时本测试自然翻红，强迫新状态先过分桶决策（编译期
// 另有 deriveFrontier / isDispatchable 内的 assertNever 双保险，design §2.3）。
// 分桶互斥同样是契约：classify() 断言每个状态入且仅入七集合
// （completed / ready / awaitingReview / awaitingHuman / failed / exhausted /
// blocked）之一，入零桶或多桶都直接抛错。
//
// blocked.reason 是诊断文本不是 API 契约（design §2.2 备注）——断言一律前缀匹配。
//
// 注：exhausted 的深组合（下游 hold / resume 路径）已被
// tests/derive-frontier-exhausted.test.ts 覆盖，此处仅保留全集扫描所需的单行；
// decideScopeOutcome 的完整优先级矩阵归 rfc095-scope-outcome.test.ts，此处只验
// "全 blocked ⇒ stalled 诊断点名各节点"这条 deriveFrontier → decideScopeOutcome 接缝。
// 纯函数直测；row()/def() 帮手复刻自 derive-frontier.test.ts（file-local，不改既有文件）。

import { describe, expect, test } from 'bun:test'
import { NODE_RUN_STATUS, type NodeRunStatus } from '@agent-workflow/shared'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'
import type { nodeRuns } from '../src/db/schema'
import { decideScopeOutcome, isDispatchable } from '../src/services/dispatchFrontier'
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
    // isReviewSupersededRow 读 errorMessage（null = 非 supersede 标记行）。
    errorMessage: null,
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

/** 一个状态值在 Frontier 里的归宿（七集合，含 RFC-095 新增的 blocked 诊断出口）。 */
type Bucket =
  | 'completed'
  | 'ready'
  | 'awaitingReview'
  | 'awaitingHuman'
  | 'failed'
  | 'exhausted'
  | 'blocked'

// 状态 → (语义上会持有该状态的节点 kind, 归宿桶[, blocked 时的 reason 前缀])。
// inFlight=NONE：表驱动建模的是"无人在飞"的静默 tick——running 即遗弃 running 行
// （runTask sink/wrapper 分支抛错后行停在 running）。
const EXPECTED: Record<NodeRunStatus, { kind: NodeKind; bucket: Bucket; reasonPrefix?: string }> = {
  // RFC-092 §1.2：out-of-band mint / placeholder —— pending-anchor bypass 放行。
  // dedup 集为空时 ready（本表行）；锚已耗的组合见下方补充用例
  // （行 id ∈ dispatchedPendingRowIds → blocked('pending-anchor-consumed')）。
  pending: { kind: 'agent-single', bucket: 'ready' },
  // RFC-095：遗弃 running 行 → blocked 诊断（曾是 S-12 黑洞）。
  running: { kind: 'agent-single', bucket: 'blocked', reasonPrefix: 'orphaned-running-row' },
  done: { kind: 'agent-single', bucket: 'completed' }, // done ∧ fresh（无 consumed ⇒ fresh）
  failed: { kind: 'agent-single', bucket: 'ready' }, // N1 resume/retry 重铸信号
  // RFC-095 / S-22：复活信号，与 interrupted 同类（supersede 标记行例外，见补充用例）。
  canceled: { kind: 'agent-single', bucket: 'ready' },
  interrupted: { kind: 'agent-single', bucket: 'ready' }, // daemon-restart 重铸信号
  // RFC-095：零 mint 点状态 → blocked 诊断；启用前必须先过 isDispatchable 显式决策。
  skipped: {
    kind: 'agent-single',
    bucket: 'blocked',
    reasonPrefix: 'skipped-has-no-dispatch-semantics',
  },
  exhausted: { kind: 'wrapper-loop', bucket: 'exhausted' }, // loop-max 真终态（深组合见 derive-frontier-exhausted.test.ts）
  awaiting_review: { kind: 'review', bucket: 'awaitingReview' }, // fresh parked leaf 保持 park（C2）
  awaiting_human: { kind: 'clarify', bucket: 'awaitingHuman' },
}

/**
 * 跑一个单节点 scope，返回该节点落入的桶（blocked 时附 reason）。
 * 入零桶（旧黑洞）或多桶（互斥破坏）都抛错——"入且仅入一个"本身是契约。
 */
function classify(
  status: NodeRunStatus,
  kind: NodeKind,
  over: Partial<Row> = {},
): { bucket: Bucket; reason?: string } {
  const { definition, scopeNodes, scopeIds } = def([{ id: 'n', kind }])
  const f = deriveFrontier(
    [row('n', status, over)],
    definition,
    scopeNodes,
    scopeIds,
    0,
    new Map(),
    NONE, // inFlight 空：遗弃行场景
    NONE, // dispatchedThisInvocation 空：排除 S-1 的去重干扰
    NONE,
  )
  const hits: Array<{ bucket: Bucket; reason?: string }> = []
  if (f.completed.has('n')) hits.push({ bucket: 'completed' })
  if (f.ready.includes('n')) hits.push({ bucket: 'ready' })
  if (f.awaitingReview.includes('n')) hits.push({ bucket: 'awaitingReview' })
  if (f.awaitingHuman.includes('n')) hits.push({ bucket: 'awaitingHuman' })
  if (f.failed.includes('n')) hits.push({ bucket: 'failed' })
  if (f.exhausted.includes('n')) hits.push({ bucket: 'exhausted' })
  const b = f.blocked.find((x) => x.nodeId === 'n')
  if (b !== undefined) hits.push({ bucket: 'blocked', reason: b.reason })
  if (hits.length !== 1) {
    throw new Error(
      `status '${status}' must fall into exactly one bucket; got ` +
        (hits.length === 0 ? 'NONE (black hole)' : hits.map((h) => h.bucket).join(',')),
    )
  }
  return hits[0]!
}

describe('S-12 / RFC-095 — deriveFrontier 状态分桶全集扫描（穷举语义锁定）', () => {
  test('EXPECTED 表覆盖 NODE_RUN_STATUS 全集（新增状态值 ⇒ 此断言翻红，强迫先过分桶决策）', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...NODE_RUN_STATUS].sort())
  })

  for (const status of NODE_RUN_STATUS) {
    const { kind, bucket, reasonPrefix } = EXPECTED[status]
    test(`latest='${status}' (kind=${kind}) → '${bucket}'${reasonPrefix === undefined ? '' : `（reason 前缀 '${reasonPrefix}'）`}`, () => {
      const got = classify(status, kind)
      expect(got.bucket).toBe(bucket)
      if (reasonPrefix !== undefined) {
        expect((got.reason ?? '').startsWith(reasonPrefix)).toBe(true)
      }
    })
  }

  // EXPECTED 表按 status 单行建模、表不下 errorMessage 维度，故独立成 case：
  // supersede 标记行是 canceled → ready 的唯一例外（design §1 标记守卫）。
  test("补充表项：canceled + superseded_by_review 列非空 → blocked('review-superseded')（supersede 等待窗口，rerun 行承载复活）", () => {
    const got = classify('canceled', 'agent-single', {
      supersededByReview: 'iterated',
    })
    expect(got.bucket).toBe('blocked')
    expect((got.reason ?? '').startsWith('review-superseded')).toBe(true)
  })

  test('原黑洞三形态全部落 blocked + allSettled=false ⇒ decideScopeOutcome 给出点名各节点的 stalled 诊断（不再是裸 "scheduler stalled"）', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'orphanA', kind: 'agent-single' },
      { id: 'supersededB', kind: 'agent-single' },
      { id: 'skippedC', kind: 'agent-single' },
    ])
    const rows = [
      row('orphanA', 'running'),
      row('supersededB', 'canceled', {
        supersededByReview: 'iterated',
      }),
      row('skippedC', 'skipped'),
    ]
    const f = deriveFrontier(rows, definition, scopeNodes, scopeIds, 0, new Map(), NONE, NONE, NONE)
    // 五出口仍全空，但卡点不再不可见：三节点全部入 blocked 诊断。
    expect(f.ready).toEqual([])
    expect(f.awaitingHuman).toEqual([])
    expect(f.awaitingReview).toEqual([])
    expect(f.failed).toEqual([])
    expect(f.exhausted).toEqual([])
    expect(f.allSettled).toBe(false)
    expect(f.blocked.map((b) => b.nodeId).sort()).toEqual(['orphanA', 'skippedC', 'supersededB'])
    // 接缝：quiescent 块的纯函数决策把 blocked 清单带进 stalled detail。
    const outcome = decideScopeOutcome(f)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') throw new Error('unreachable')
    expect(outcome.detail.message).toBe('no ready nodes in scope') // 机器面恒定（design §3）
    expect(outcome.detail.summary.startsWith('scheduler stalled')).toBe(true)
    for (const id of ['orphanA', 'supersededB', 'skippedC']) {
      expect(outcome.detail.summary).toContain(id)
    }
    expect(outcome.detail.nodeId).toBe(f.blocked[0]!.nodeId)
  })

  // RFC-092 补充表项（EXPECTED 表按 status 单行建模、表不下这组组合，故独立成 case）：
  // pending ∈ dispatchedThisInvocation 时的两种归宿 —— 行 id 一次性豁免的两侧。
  test("RFC-092：pending ∈ dispatchedThisInvocation + 空 dispatchedPendingRowIds → ready（anchor 暴露）；行 id ∈ dispatchedPendingRowIds → blocked('pending-anchor-consumed')（有界退化，可诊断）", () => {
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
    expect(released.blocked).toEqual([])
    // 侧 2：同一行 id 已豁免过 → 不 ready、不入停泊桶，落 blocked 诊断
    //（= stall 语义防 busy-loop，但卡点点名而非黑洞）。
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
    expect(bounded.blocked).toHaveLength(1)
    expect(bounded.blocked[0]!.nodeId).toBe('n')
    expect(bounded.blocked[0]!.status).toBe('pending')
    expect(bounded.blocked[0]!.reason.startsWith('pending-anchor-consumed')).toBe(true)
    expect(bounded.allSettled).toBe(false)
  })

  test("isDispatchable('skipped') → false（dispatch-frontier.test.ts 唯一未覆盖的状态值；canceled/running 已被其覆盖）", () => {
    // 与 deriveFrontier 表的 skipped 行互为印证：gate 拒绝 + blocked 诊断收纳
    //（RFC-095 后不再是黑洞——分桶侧见上方表驱动用例）。
    const r = row('n', 'skipped')
    expect(
      isDispatchable(r, 'agent-single', new Map(), [r], {
        nodes: [],
        edges: [],
      } as unknown as WorkflowDefinition),
    ).toBe(false)
  })

  test('S-22 翻转：canceled 上游本身 ready（复活信号），下游等上游 done 前不 ready 也不入 blocked —— 链路不再死锁', () => {
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
    // 复活信号：canceled 上游直接可派发，scope 由它推进。
    expect(f.ready).toEqual(['up'])
    // 等上游不是卡点（design §2.2：blocked 诊断分支过「上游就绪 ∧ 不在飞」闸）。
    expect(f.blocked).toEqual([])
    expect(f.allSettled).toBe(false)
  })
})
