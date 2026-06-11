// S-3 已修（RFC-098 B3 / WP-6c，案二「扩展谓词」）——本文件从 CURRENT-BEHAVIOR
// LOCK 翻转为修复后语义的回归防护。原始报告：design/scheduler-audit-2026-06-10.md
// S-3 (WP-6c)；修法裁决见 design/RFC-098-scheduler-closeout/design.md §B3 +
// 对抗检视修订 #8。
//
// 修复前缺陷：wrapper(loop/git) 内的 review 被 approve 后，approve 分支只把
// review 行翻 done + 发布 approved_doc（services/review.ts），既不铸任何 pending
// 行、也不碰 wrapper 行；而 wrapper awaiting_* 行的唯一放行条件
// wrapperHasFreshInnerWork 只扫描 status === 'pending' 的 inner 行 → "approve 后
// 形态"（inner 全 done、无 pending）恒 false → 任务永远弹回 awaiting_review。
//
// 修复后语义（本文件锁定）：wrapperRevivalEvidence（dispatchFrontier.ts）把
// 「窗口内 kind==='review' 的 done∧fresh 行」也视为复活证据——approve 翻 done 的
// review 行本身就是放行信号；非 review 的 inner done 行**不**解锁（clarify park
// 语义不受影响，dispatch-frontier.test.ts N2 锁定）。fresh 判定按修订 #8 在函数
// 内部以 innerIter 构 buildFreshestDonePerNode——误用外层 map 即回归。
// 任何 refactor 把下方 [S-3 LOCK] 断言翻回 false = S-3 回归。
//
// 既有覆盖说明：dispatch-frontier.test.ts 锁 awaiting_human + 无 pending +
// inner 为 agent done → false（clarify 未答完，停 park 是正确的）。本文件锁的是
// 同一谓词在 awaiting_review + post-approve（inner 含 review done）形态下放行，
// 二者不可互相替代。
//
// 纯函数直测，仿 dispatch-frontier.test.ts 的 run()/def() 形态。

import { describe, expect, test } from 'bun:test'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'
import type { nodeRuns } from '../src/db/schema'
import {
  isDispatchable,
  wrapperHasFreshInnerWork,
  wrapperRevivalEvidence,
} from '../src/services/dispatchFrontier'
import { encodeWrapperProgress } from '../src/services/wrapperProgress'

type Row = typeof nodeRuns.$inferSelect

function run(over: Partial<Row>): Row {
  return {
    id: '01R',
    nodeId: 'n',
    iteration: 0,
    status: 'done',
    parentNodeRunId: null,
    consumedUpstreamRunsJson: null,
    wrapperProgressJson: null,
    ...over,
  } as unknown as Row
}

const NO_FRESH = new Map<string, Row>()

function def(nodes: Array<{ id: string; kind: NodeKind; nodeIds?: string[] }>): WorkflowDefinition {
  return { nodes, edges: [] } as unknown as WorkflowDefinition
}

// loop ∋ { worker(agent), rev(review) } — "loop 内迭代到 review 通过为止"正是
// loop wrapper 的目标场景（audit S-3 触发条件）。
const LOOP_DEF = def([
  { id: 'lw', kind: 'wrapper-loop', nodeIds: ['worker', 'rev'] },
  { id: 'worker', kind: 'agent-single' },
  { id: 'rev', kind: 'review' },
])

const GIT_DEF = def([
  { id: 'gw', kind: 'wrapper-git', nodeIds: ['worker', 'rev'] },
  { id: 'worker', kind: 'agent-single' },
  { id: 'rev', kind: 'review' },
])

describe('S-3 — wrapper-loop ∋ review 被 approve 后复活（机制核心，已修）', () => {
  // 真实 DB 形态：wrapper 行在 parentIteration=0 park（park-review →
  // awaiting_review），progress 记录 inner 停在 loop 计数器 i=1；
  // approve 之后 inner 的 review 行被翻 done，worker 行本来就是 done，
  // 没有任何人铸 pending 行——done∧fresh 的 review 行即复活证据。
  const parkedLoopRow = run({
    id: '01W',
    nodeId: 'lw',
    iteration: 0,
    status: 'awaiting_review',
    wrapperProgressJson: encodeWrapperProgress({ kind: 'loop', iteration: 1, phase: 'awaiting' }),
  })
  const postApproveRows = [
    parkedLoopRow,
    run({ id: '01A', nodeId: 'worker', status: 'done', iteration: 1 }),
    // approve 分支把 review 行翻 done（consumed=null → 恒 fresh），不铸 pending。
    run({ id: '01B', nodeId: 'rev', status: 'done', iteration: 1 }),
  ]

  test('[S-3 LOCK·已翻转] approve 后形态（inner 全 done、含 fresh done review）→ wrapperHasFreshInnerWork = true', () => {
    expect(wrapperHasFreshInnerWork(parkedLoopRow, postApproveRows, LOOP_DEF)).toBe(true)
  })

  test('[S-3 LOCK·已翻转] 因而 isDispatchable(awaiting_review wrapper-loop) = true —— resume 即复活，不再恒弹回 park', () => {
    expect(isDispatchable(parkedLoopRow, 'wrapper-loop', NO_FRESH, postApproveRows, LOOP_DEF)).toBe(
      true,
    )
  })

  test('证据形态：wrapperRevivalEvidence 返回 approve 翻 done 的 review 行（rowId+nodeId）', () => {
    expect(wrapperRevivalEvidence(parkedLoopRow, postApproveRows, LOOP_DEF)).toEqual({
      rowId: '01B',
      nodeId: 'rev',
    })
  })

  test('负例：非 review 的 inner done 不解锁（worker done 单独存在 → 证据为 null）', () => {
    // 没有 review done 行、也没有 pending 行——agent done 不是复活证据，否则
    // clarify park 直接失效（dispatch-frontier.test.ts N2 同口径）。
    const agentDoneOnly = [
      parkedLoopRow,
      run({ id: '01A', nodeId: 'worker', status: 'done', iteration: 1 }),
    ]
    expect(wrapperRevivalEvidence(parkedLoopRow, agentDoneOnly, LOOP_DEF)).toBeNull()
    expect(wrapperHasFreshInnerWork(parkedLoopRow, agentDoneOnly, LOOP_DEF)).toBe(false)
    expect(isDispatchable(parkedLoopRow, 'wrapper-loop', NO_FRESH, agentDoneOnly, LOOP_DEF)).toBe(
      false,
    )
  })

  test('对照组：inner pending 行（clarify 答复 rerun 形态）依旧放行，且 max-id 证据胜出', () => {
    const withPending = [
      ...postApproveRows,
      run({ id: '01C', nodeId: 'rev', status: 'pending', iteration: 1 }),
    ]
    expect(wrapperHasFreshInnerWork(parkedLoopRow, withPending, LOOP_DEF)).toBe(true)
    expect(isDispatchable(parkedLoopRow, 'wrapper-loop', NO_FRESH, withPending, LOOP_DEF)).toBe(
      true,
    )
    // pending 行 id '01C' > done 行 '01B' → 证据取窗口内 max-id 行。
    expect(wrapperRevivalEvidence(parkedLoopRow, withPending, LOOP_DEF)).toEqual({
      rowId: '01C',
      nodeId: 'rev',
    })
  })

  test('窗口取值规则：loop 的扫描窗口来自 wrapperProgressJson.iteration，不是 wrapper 行自身 iteration', () => {
    // pending / review-done 都落在 wrapper 行自身的 iteration=0（≠ progress 窗口 1）
    // 不解锁——复活证据必须落在 progress 窗口上才有效（两类证据同规）。
    const wrongAxis = [
      parkedLoopRow,
      run({ id: '01A', nodeId: 'worker', status: 'done', iteration: 0 }),
      run({ id: '01B', nodeId: 'rev', status: 'done', iteration: 0 }),
      run({ id: '01C', nodeId: 'rev', status: 'pending', iteration: 0 }),
    ]
    expect(wrapperHasFreshInnerWork(parkedLoopRow, wrongAxis, LOOP_DEF)).toBe(false)
    // 而落在 progress 窗口 iteration=1 上的同款行解锁（上方用例已证）。
  })

  test('修订 #8 契约：review done 行的 fresh 判定按 innerIter 内部构图——窗口内 stale 的 done review 不解锁', () => {
    // rev 的 done 行 consumed 了 worker 的旧 run（01OLD），而窗口内 worker 的
    // freshest done 已是 01A → 该 review done 行 stale，不是复活证据。若实现误用
    // 外层（wrapper iteration=0 作用域）的 freshestDone map，worker@iter1 不在图
    // 内 → 误判 fresh → 本断言翻红。
    const staleReviewDone = [
      parkedLoopRow,
      run({ id: '01A', nodeId: 'worker', status: 'done', iteration: 1 }),
      run({
        id: '019',
        nodeId: 'rev',
        status: 'done',
        iteration: 1,
        consumedUpstreamRunsJson: JSON.stringify({ worker: '01OLD' }),
      }),
    ]
    expect(wrapperRevivalEvidence(parkedLoopRow, staleReviewDone, LOOP_DEF)).toBeNull()
    expect(wrapperHasFreshInnerWork(parkedLoopRow, staleReviewDone, LOOP_DEF)).toBe(false)
  })
})

describe('S-3 — wrapper-git ∋ review 被 approve 后复活（同型，已修）', () => {
  // git wrapper 的 inner 共享 wrapper 行自身的 iteration（dispatchFrontier.ts）；
  // progress 是 {kind:'git', baseline} 不含 iteration。这里把 wrapper 放在
  // iteration=2 以同时锁住 git 的窗口取值规则。
  const parkedGitRow = run({
    id: '01W',
    nodeId: 'gw',
    iteration: 2,
    status: 'awaiting_review',
    wrapperProgressJson: encodeWrapperProgress({
      kind: 'git',
      baseline: 'abc123',
      phase: 'awaiting',
    }),
  })
  const postApproveRows = [
    parkedGitRow,
    run({ id: '01A', nodeId: 'worker', status: 'done', iteration: 2 }),
    run({ id: '01B', nodeId: 'rev', status: 'done', iteration: 2 }),
  ]

  test('[S-3 LOCK·已翻转] approve 后形态 → wrapperHasFreshInnerWork = true 且 isDispatchable = true', () => {
    expect(wrapperHasFreshInnerWork(parkedGitRow, postApproveRows, GIT_DEF)).toBe(true)
    expect(isDispatchable(parkedGitRow, 'wrapper-git', NO_FRESH, postApproveRows, GIT_DEF)).toBe(
      true,
    )
    expect(wrapperRevivalEvidence(parkedGitRow, postApproveRows, GIT_DEF)).toEqual({
      rowId: '01B',
      nodeId: 'rev',
    })
  })

  test('对照组 + 窗口规则：证据落在 wrapper 自身 iteration=2 解锁；落在 0 不解锁', () => {
    const atOwnIter = [
      ...postApproveRows,
      run({ id: '01C', nodeId: 'rev', status: 'pending', iteration: 2 }),
    ]
    expect(wrapperHasFreshInnerWork(parkedGitRow, atOwnIter, GIT_DEF)).toBe(true)
    expect(isDispatchable(parkedGitRow, 'wrapper-git', NO_FRESH, atOwnIter, GIT_DEF)).toBe(true)

    // pending 与 review-done 全部落在 iteration=0（≠ wrapper 自身 iteration=2）
    // → 两类证据都不解锁。
    const atWrongIter = [
      parkedGitRow,
      run({ id: '01A', nodeId: 'worker', status: 'done', iteration: 0 }),
      run({ id: '01B', nodeId: 'rev', status: 'done', iteration: 0 }),
      run({ id: '01C', nodeId: 'rev', status: 'pending', iteration: 0 }),
    ]
    expect(wrapperHasFreshInnerWork(parkedGitRow, atWrongIter, GIT_DEF)).toBe(false)
  })
})
