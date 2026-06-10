// RFC-092 修复后的正确语义锁定 — design/scheduler-audit-2026-06-10.md S-1（WP-1 止血）
// 设计依据：design/RFC-092-scheduler-p0-stopgap/design.md §1.2（pending 锚点按行 id 一次性豁免）
//
// 修复前的缺陷（已由 RFC-092 消除，本文件原为 CURRENT-BEHAVIOR LOCK）：runScope 的
// `dispatchedThisInvocation`（节点级、整个调用期只 add 不清）被 ready 判定用成无条件排除，
// clarify 答复 / review iterate/reject 给【本次调用已派发过的】节点铸出的 pending rerun 行
// 因此不 ready、不落任何桶、不 completed —— 慢速 sibling 收尾后 runScope 静默块五个出口
// 全不命中，任务以零诊断价值的 `'scheduler stalled'` 假失败收场。
//
// RFC-092 语义（本文件现在锁定的正确行为）：
//   - latest 为 pending 的行是显式新工作信号（pendingAnchorReleasable）：行 id ∉
//     dispatchedPendingRowIds（deriveFrontier 第 11 参，默认空集）且节点无 open asking
//     session 时，绕过节点级去重放行 ready；`Frontier.pendingAnchors` 暴露
//     (nodeId → pending 行 id) 供 runScope 记账。
//   - 同一行 id 至多放行一次：runScope 派发时把 anchor 记入 dispatchedPendingRowIds，
//     未被消费的泄漏 pending 行回到 stall 语义（有界退化，防 busy-loop —— design §1.3；
//     深组合见 rfc092-leaked-pending-bounded.test.ts）。
//   - out-of-band 新铸行（clarify 答复 clarify.ts / review iterate-reject review.ts）持有
//     新 ULID ⇒ 不在豁免集内 ⇒ 恰好再放行一次。
//
// 对照测试（去重集为空 = 手动 resume 的新调用时 ready）语义不受修复影响，保持原样。
// 纯函数直测 deriveFrontier（已导出）；row()/def() 帮手复刻自 derive-frontier.test.ts
// （那里是 file-local，不改既有文件）。

import { describe, expect, test } from 'bun:test'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'
import type { nodeRuns } from '../src/db/schema'
import { deriveFrontier } from '../src/services/scheduler'

type Row = typeof nodeRuns.$inferSelect
type WorkflowNode = WorkflowDefinition['nodes'][number]
const NONE: ReadonlySet<string> = new Set()

let seq = 0
function row(nodeId: string, status: string, over: Partial<Row> = {}): Row {
  // Monotonic id so isFresherNodeRun (pure id-order) picks the last-inserted row.
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

const ups = (m: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(m))

// 菱形 in → {asker, sib} → out。asker 第一跑 done 后发了 clarify；用户在 sib 还在跑时
// 通过收件箱答题，submitClarifyAnswers 给 asker 铸 pending rerun（更晚 id，会话已关闭
// 所以 askingRunIds 为空）。asker/sib 都已在本次 runScope 调用里派发过。
function diamondScenario() {
  const { definition, scopeNodes, scopeIds } = def([
    { id: 'in', kind: 'input' },
    { id: 'asker', kind: 'agent-single' },
    { id: 'sib', kind: 'agent-single' },
    { id: 'out', kind: 'output' },
  ])
  const askerDone = row('asker', 'done') // 第一跑（发问的那次）
  const askerRerun = row('asker', 'pending') // submitClarifyAnswers 铸的 rerun（更晚 id ⇒ latest）
  const rows = [row('in', 'done'), askerDone, askerRerun, row('sib', 'done')]
  const upstreams = ups({ asker: ['in'], sib: ['in'], out: ['asker', 'sib'] })
  return { definition, scopeNodes, scopeIds, rows, upstreams, askerRerun }
}

describe('S-1 (RFC-092 fixed) — mid-run clarify answer 的 pending rerun 经 pending-anchor bypass 放行', () => {
  test('sibling 收尾后（inFlight 空），pending rerun 放行 ready，pendingAnchors 暴露行 id —— 不再 "scheduler stalled"', () => {
    const { definition, scopeNodes, scopeIds, rows, upstreams, askerRerun } = diamondScenario()
    // asker 与 sib 本次调用都派发过；sib 已完成离开 inFlight，asker 第一跑也早已 settle。
    const dispatched = new Set(['asker', 'sib'])
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      upstreams,
      NONE, // inFlight 空
      dispatched,
      NONE, // clarify 会话已答complete ⇒ 无 open session
      NONE, // askingRunIds 空（会话已 answered）
      NONE, // dispatchedPendingRowIds 空 ⇒ 该 pending 行尚未被豁免过 ⇒ 放行
    )
    // RFC-092 §1.2：pending rerun 绕过节点级去重放行 ready。
    expect(f.ready).toEqual(['asker'])
    // anchor 记账接口：runScope 派发时把该行 id 记入 dispatchedPendingRowIds。
    expect(f.pendingAnchors.get('asker')).toBe(askerRerun.id)
    expect(f.completed.has('asker')).toBe(false)
    // ready 即不入 awaiting/failed/exhausted 任何一桶（分桶互斥）。
    expect(f.awaitingHuman).toEqual([])
    expect(f.awaitingReview).toEqual([])
    expect(f.failed).toEqual([])
    expect(f.exhausted).toEqual([])
    // 下游 out 仍被未完成的 asker 挡住（等 rerun 跑完），但 scope 有 ready 工作，
    // runScope 不进静默块 ⇒ 不可能落 'scheduler stalled' 兜底。
    expect(f.ready).not.toContain('out')
    expect(f.allSettled).toBe(false)
  })

  test('对照：去重集为空（= 手动 resume 的新调用）时同样的行集 asker 正常 ready —— bypass 不改变新调用语义', () => {
    const { definition, scopeNodes, scopeIds, rows, upstreams } = diamondScenario()
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      upstreams,
      NONE,
      NONE, // 新调用：去重集为空
      NONE,
    )
    expect(f.ready).toEqual(['asker'])
    expect(f.allSettled).toBe(false)
  })

  test('两 tick 时序（修复后）：sib 在飞时 rerun 即刻 ready（无需等 sibling）；anchor 记账后同一行不再二次放行（有界）', () => {
    const { definition, scopeNodes, scopeIds, upstreams } = diamondScenario()
    // tick 1：sib 还在跑（inFlight），asker 第一跑 done 且用户刚答完题（pending rerun 已落库）。
    const askerDone = row('asker', 'done')
    const askerRerun = row('asker', 'pending')
    const rowsTick1 = [row('in', 'done'), askerDone, askerRerun, row('sib', 'running')]
    const dispatched = new Set(['asker', 'sib'])
    const f1 = deriveFrontier(
      rowsTick1,
      definition,
      scopeNodes,
      scopeIds,
      0,
      upstreams,
      new Set(['sib']), // sib in flight
      dispatched,
      NONE,
      NONE,
      NONE, // anchor 尚未记账
    )
    // RFC-092：rerun 在 sib 仍在飞时就被拾起 —— mid-run 答复即刻生效，不等慢 sibling。
    expect(f1.ready).toEqual(['asker'])
    expect(f1.pendingAnchors.get('asker')).toBe(askerRerun.id)
    expect(f1.allSettled).toBe(false)

    // tick 2（病理形态）：runScope 已把 anchor 记入 dispatchedPendingRowIds，但派发
    // 未消费该 pending 行（早期失败 return 等），行仍是 latest；sib 收尾 done。
    // 同一行 id 已豁免过 ⇒ 不再放行、不入桶 —— 回到 stall 语义（有界退化，杜绝
    // busy-loop；design §1.3，深组合见 rfc092-leaked-pending-bounded.test.ts）。
    const rowsTick2 = [row('in', 'done'), askerDone, askerRerun, row('sib', 'done')]
    const f2 = deriveFrontier(
      rowsTick2,
      definition,
      scopeNodes,
      scopeIds,
      0,
      upstreams,
      NONE,
      dispatched,
      NONE,
      NONE,
      new Set([askerRerun.id]), // anchor 已记账 ⇒ 一次性豁免已用掉
    )
    expect(f2.ready).toEqual([])
    expect(f2.pendingAnchors.size).toBe(0)
    expect(f2.allSettled).toBe(false)
    expect(f2.awaitingHuman).toEqual([])
    expect(f2.awaitingReview).toEqual([])
    expect(f2.failed).toEqual([])
    expect(f2.exhausted).toEqual([])
  })
})
