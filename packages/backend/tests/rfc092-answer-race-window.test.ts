// RFC-092 §1.2b — 答复竞态窗口守卫（openAskingNodeIds）锁定。
// 设计依据：design/RFC-092-scheduler-p0-stopgap/design.md §1.2b / §5-11；
// 调研：design/scheduler-audit-2026-06-10.md S-1 / S-10。
//
// 为什么存在这条测试：submitClarifyAnswers 的写序是【先铸 rerun 行、后写答案并翻
// session 为 answered】，且 bun:sqlite 下 db.transaction 无原子性。S-1 的
// pending-anchor bypass（行 id 一次性豁免）会重新打开「rerun 已铸、答案未写」窗口
// —— 若 sibling 恰在窗口内 settle 触发 tick，rerun 会无答案起跑。守卫：deriveFrontier
// 在内部由 askingRunIds × rows 推导 openAskingNodeIds（open session 的源 agent /
// questioner 节点 id 集），pendingAnchorReleasable 要求节点 ∉ 该集合；session 翻
// answered 后（loadOpenClarify 不再返回该 askingRunId）下一 tick 自然放行。
// cross-clarify questioner 同口径（crossClarify.ts mintQuestionerRerun 的铸行同样
// 先于 session 状态翻转，rerun 落在 questioner 节点自身）。
//
// 纯函数直测 deriveFrontier（已导出）；row()/def() 帮手复刻自 derive-frontier.test.ts
// （file-local，不改既有文件）。

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

describe('RFC-092 §1.2b — answer-race window（openAskingNodeIds 守卫）', () => {
  // self-clarify 形态：asker 第一跑 done 后发问（asking 行）；submitClarifyAnswers
  // 已铸 rerun（pending、更晚 id ⇒ latest）但答案还没写完 —— session 仍 open，
  // loadOpenClarify 仍返回 asking 行 id。asker 本次调用已派发过（mid-run）。
  function selfClarifyScenario() {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'in', kind: 'input' },
      { id: 'asker', kind: 'agent-single' },
      { id: 'sib', kind: 'agent-single' },
    ])
    const askerAsking = row('asker', 'done') // 发问的那跑（id ∈ askingRunIds 当窗口开着）
    const askerRerun = row('asker', 'pending') // 已铸、可能还没答案的 rerun（latest）
    const rows = [row('in', 'done'), askerAsking, askerRerun, row('sib', 'running')]
    const upstreams = ups({ asker: ['in'], sib: ['in'] })
    const dispatched = new Set(['asker', 'sib'])
    const inFlight = new Set(['sib'])
    return {
      definition,
      scopeNodes,
      scopeIds,
      rows,
      upstreams,
      dispatched,
      inFlight,
      askerAsking,
      askerRerun,
    }
  }

  test('self-clarify：窗口开着（askingRunIds 含 asking 行 id）→ rerun 不 ready、无 anchor —— 无答案起跑被守卫挡住', () => {
    const s = selfClarifyScenario()
    const f = deriveFrontier(
      s.rows,
      s.definition,
      s.scopeNodes,
      s.scopeIds,
      0,
      s.upstreams,
      s.inFlight,
      s.dispatched,
      NONE,
      new Set([s.askerAsking.id]), // session 未 answered ⇒ asking 行 id 在集合内
      NONE,
    )
    // openAskingNodeIds（内部由 askingRunIds × rows 推导）含 asker ⇒ bypass 关闭；
    // 节点又 ∈ dispatchedThisInvocation ⇒ 常规路径也不放行。
    expect(f.ready).toEqual([])
    expect(f.ready).not.toContain('asker')
    expect(f.pendingAnchors.has('asker')).toBe(false)
    expect(f.completed.has('asker')).toBe(false)
    // sib 还在飞，scope 不会静默 —— 窗口是 sub-tick 级瞬态，下一 tick 答案写完即放行。
    expect(f.allSettled).toBe(false)
  })

  test('self-clarify：答案已写、session answered（askingRunIds 清空）→ 同一 rows 即放行 ready 且 pendingAnchors 含 rerun 行 id', () => {
    const s = selfClarifyScenario()
    const f = deriveFrontier(
      s.rows,
      s.definition,
      s.scopeNodes,
      s.scopeIds,
      0,
      s.upstreams,
      s.inFlight,
      s.dispatched,
      NONE,
      NONE, // session 翻 answered ⇒ loadOpenClarify 不再返回该 asking 行 id
      NONE,
    )
    expect(f.ready).toEqual(['asker'])
    expect(f.pendingAnchors.get('asker')).toBe(s.askerRerun.id)
    expect(f.allSettled).toBe(false)
  })

  // cross-clarify questioner 同型：questioner 发问后 mintQuestionerRerun 给
  // questioner 节点自身铸 pending rerun，铸行同样先于 cross_clarify_sessions 状态
  // 翻转；窗口内 loadOpenClarify 返回 questioner asking 行 id + cross-clarify 节点 id。
  function crossClarifyScenario() {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'in', kind: 'input' },
      { id: 'q', kind: 'agent-single' },
      { id: 'cc', kind: 'clarify-cross-agent' },
    ])
    const qAsking = row('q', 'done') // questioner 发问的那跑
    const qRerun = row('q', 'pending') // mintQuestionerRerun 铸的 rerun（latest）
    const rows = [row('in', 'done'), qAsking, qRerun]
    const upstreams = ups({ q: ['in'], cc: ['q'] })
    const dispatched = new Set(['q'])
    return { definition, scopeNodes, scopeIds, rows, upstreams, dispatched, qAsking, qRerun }
  }

  test('cross-clarify questioner 同型：窗口内不 ready；answered 后同一 rows → ready + anchor', () => {
    const s = crossClarifyScenario()
    // 窗口开着：session 仍 awaiting_human ⇒ askingRunIds 含 questioner asking 行 id，
    // openClarifyNodeIds 含 cc（N6 正向证据，挡住 cc 的 settles-without-row）。
    const open = deriveFrontier(
      s.rows,
      s.definition,
      s.scopeNodes,
      s.scopeIds,
      0,
      s.upstreams,
      NONE,
      s.dispatched,
      new Set(['cc']),
      new Set([s.qAsking.id]),
      NONE,
    )
    expect(open.ready).toEqual([])
    expect(open.pendingAnchors.has('q')).toBe(false)
    expect(open.completed.has('q')).toBe(false)
    expect(open.completed.has('cc')).toBe(false)
    expect(open.allSettled).toBe(false)

    // 窗口关闭：session 翻 answered ⇒ 两个 open-session 集合都清空。
    const closed = deriveFrontier(
      s.rows,
      s.definition,
      s.scopeNodes,
      s.scopeIds,
      0,
      s.upstreams,
      NONE,
      s.dispatched,
      NONE,
      NONE,
      NONE,
    )
    expect(closed.ready).toEqual(['q'])
    expect(closed.pendingAnchors.get('q')).toBe(s.qRerun.id)
    // cc 的 settle 要等 questioner rerun 跑完（上游未 completed）—— 不误放行。
    expect(closed.ready).not.toContain('cc')
    expect(closed.allSettled).toBe(false)
  })
})
