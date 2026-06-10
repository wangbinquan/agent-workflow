// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-1 (WP-1; structural finish WP-2)
//
// 当前缺陷行为：runScope 的 `dispatchedThisInvocation`（scheduler.ts:606）整个调用期内
// 只 add 不清；deriveFrontier 的 ready 判定含 `!dispatchedThisInvocation.has(n.id)`
// （scheduler.ts:1123）。clarify 答复（routes/clarify.ts submitClarifyAnswers）/ review
// iterate/reject 给【本次调用已派发过的】节点铸出的 pending rerun 行因此：
//   - 不 ready（被去重集挡住）；
//   - 不落任何桶（分桶只枚举 awaiting_review / awaiting_human / failed，
//     scheduler.ts:1129-1132 —— pending 不在内）；
//   - 不 completed ⇒ allSettled=false。
// 当慢速 sibling 收尾、inFlight 清空后，runScope 的静默块（scheduler.ts:643-678）
// 五个出口全不命中，必然落到兜底分支：
//   `{ summary: 'scheduler stalled', message: 'no ready nodes in scope' }`
// —— 任务以零诊断价值的假失败收场，已答的 clarify 看似丢失（手动 resume 可自愈，
// 因为新调用的去重集为空）。
//
// 正确语义：latest 行是 pending 且不在 inFlight 的节点应放行 ready（pending 行本身是
// 幂等派发锚点，runOneNode 复用 pendingExisting 行不会重复铸行）；或静默块把
// "存在 pending latest 但被 invocation 去重挡住" 识别为继续循环而非 stalled。
//
// 修复落点：WP-1（P0 止血），结构化收尾在 WP-2（decideScopeOutcome 抽取 + 状态穷举）。
// 修复时本文件应翻红：按各断言旁的 FLIP 注释翻转期望值（pending rerun 进 ready /
// 或获得显式"继续循环"信号），对照测试（去重集为空时 ready）应保持绿。
//
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
  return { definition, scopeNodes, scopeIds, rows, upstreams }
}

describe('S-1 — mid-run clarify answer 的 pending rerun 被 dispatchedThisInvocation 永久屏蔽', () => {
  test('LOCK: sibling 收尾后（inFlight 空），pending rerun 不 ready、不落任何桶、allSettled=false ⇒ runScope 必然 "scheduler stalled"', () => {
    const { definition, scopeNodes, scopeIds, rows, upstreams } = diamondScenario()
    // asker 与 sib 本次调用都派发过；sib 已完成离开 inFlight，asker 第一跑也早已 settle。
    const dispatched = new Set(['asker', 'sib'])
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      upstreams,
      NONE, // inFlight 空 —— runScope 下一 tick 即进静默块
      dispatched,
      NONE, // clarify 会话已答complete ⇒ 无 open session
    )
    // FLIP on fix: pending rerun 应放行 ready（或获得显式继续信号）。
    expect(f.ready).toEqual([])
    expect(f.completed.has('asker')).toBe(false)
    // 黑洞实锤：pending latest 不落 awaiting/failed/exhausted 任何一桶。
    // FLIP on fix: 若修复走"识别 pending latest 继续循环"路线，这组断言改为对应新信号。
    expect(f.awaitingHuman).not.toContain('asker')
    expect(f.awaitingReview).not.toContain('asker')
    expect(f.failed).not.toContain('asker')
    expect(f.exhausted).not.toContain('asker')
    // 下游 out 被 asker 卡住，整个 scope 走不完。
    expect(f.ready).not.toContain('out')
    expect(f.allSettled).toBe(false)
    // 此 Frontier 形态（ready 空 + 四桶空 + allSettled=false + inFlight 空）在
    // runScope 静默块（scheduler.ts:643-678）唯一对应 'scheduler stalled' 兜底分支。
    expect(f.awaitingHuman).toEqual([])
    expect(f.awaitingReview).toEqual([])
    expect(f.failed).toEqual([])
    expect(f.exhausted).toEqual([])
  })

  test('对照：去重集为空（= 手动 resume 的新调用）时同样的行集 asker 正常 ready —— 证明屏蔽源头就是 dispatchedThisInvocation', () => {
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

  test('两 tick 时序复现：sib 在飞时不 stall（inFlight 非空），sib 收尾后 rerun 仍被挡 ⇒ 静默即 stalled', () => {
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
    )
    // rerun 已经被挡（缺陷在 tick 1 即生效），但 runScope 还不会 stall——inFlight 非空。
    expect(f1.ready).toEqual([])
    expect(f1.allSettled).toBe(false)

    // tick 2：sib 收尾 done、离开 inFlight；去重集仍含 asker（只 add 不清）。
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
    )
    // FLIP on fix: f2.ready 应为 ['asker']。
    expect(f2.ready).toEqual([])
    expect(f2.allSettled).toBe(false)
    expect(f2.awaitingHuman).toEqual([])
    expect(f2.awaitingReview).toEqual([])
    expect(f2.failed).toEqual([])
    expect(f2.exhausted).toEqual([])
  })
})
