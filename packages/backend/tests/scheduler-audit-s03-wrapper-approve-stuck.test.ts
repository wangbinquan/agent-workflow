// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-3 (WP-6c)
//
// 当前缺陷行为：wrapper(loop/git) 内的 review 被 approve 后，approve 分支只把
// review 行翻 done + 发布 approved_doc（services/review.ts:1534-1621），既不铸任何
// pending 行、也不碰 wrapper 行；而 resume 后 wrapper awaiting_* 行的唯一放行条件
// wrapperHasFreshInnerWork（services/dispatchFrontier.ts:87-106）只扫描
// status === 'pending' 的 inner 行 → "approve 后形态"（inner 全 done、无 pending）
// 恒 false → isDispatchable（:140-141）恒 false → 任务永远弹回 awaiting_review。
//
// 正确语义：approve 应当让 parked 的祖先 wrapper 行可再派发（修法二选一：approve
// 路径检测 parked 祖先 wrapper 并把它翻回 pending / 铸 inner pending 行；或扩展
// wrapperHasFreshInnerWork 把"窗口内 fresh 的 done review 行"也视为 fresh inner
// work）。修复落在 WP-6c（approve-in-wrapper 复活）。
//
// 修复时本文件应翻红，按各断言旁注释翻转期望值：
//   - 若修法是"approve 铸 pending / wrapper 翻 pending"：本文件的纯函数断言可能
//     保持绿（谓词本身不变），此时应在 approve 路径的集成测试里验证复活，并把本
//     文件顶部注释改为"谓词契约锁定"。
//   - 若修法是"扩展 wrapperHasFreshInnerWork"：把下方标 [S-3 LOCK] 的 false 断言
//     翻成 true。
//
// 既有覆盖说明：dispatch-frontier.test.ts 已锁 awaiting_human + 无 pending → false
// 的通用谓词形态（那里语义是"clarify 未答完，停 park 是正确的"）。本文件锁的是
// 同一谓词在 awaiting_review + post-approve 形态下的结果——对 approve 而言这个
// false 是缺陷（无人会再铸 pending 行），二者不可互相替代。
//
// 纯函数直测，仿 dispatch-frontier.test.ts 的 run()/def() 形态。

import { describe, expect, test } from 'bun:test'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'
import type { nodeRuns } from '../src/db/schema'
import { isDispatchable, wrapperHasFreshInnerWork } from '../src/services/dispatchFrontier'
import { encodeWrapperProgress } from '../src/services/wrapperProgress'

type Row = typeof nodeRuns.$inferSelect

function run(over: Partial<Row>): Row {
  return {
    id: '01R',
    nodeId: 'n',
    iteration: 0,
    status: 'done',
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

describe('S-3 — wrapper-loop ∋ review 被 approve 后的 park 死锁（机制核心）', () => {
  // 真实 DB 形态：wrapper 行在 parentIteration=0 park（park-review →
  // awaiting_review），progress 记录 inner 停在 loop 计数器 i=1；
  // approve 之后 inner 的 review 行被翻 done，worker 行本来就是 done，
  // 没有任何人铸 pending 行。
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

  test('[S-3 LOCK] approve 后形态（inner 全 done、无 pending）→ wrapperHasFreshInnerWork = false', () => {
    // 修复若走"扩展谓词"路线，此断言应翻成 true（fresh done review 即 fresh work）。
    expect(wrapperHasFreshInnerWork(parkedLoopRow, postApproveRows, LOOP_DEF)).toBe(false)
  })

  test('[S-3 LOCK] 因而 isDispatchable(awaiting_review wrapper-loop) = false —— resume 恒弹回 park', () => {
    // 这是"两次 resume 恒卡死"的机制核心：wrapper 行 awaiting_review 的唯一放行
    // 通道就是 wrapperHasFreshInnerWork，恒 false → 永久不可派发。
    expect(isDispatchable(parkedLoopRow, 'wrapper-loop', NO_FRESH, postApproveRows, LOOP_DEF)).toBe(
      false,
    )
  })

  test('对照组：若 approve 曾铸 inner pending 行（WP-6c 修法之一）→ 谓词即放行', () => {
    const withPending = [
      ...postApproveRows,
      run({ id: '01C', nodeId: 'rev', status: 'pending', iteration: 1 }),
    ]
    expect(wrapperHasFreshInnerWork(parkedLoopRow, withPending, LOOP_DEF)).toBe(true)
    expect(isDispatchable(parkedLoopRow, 'wrapper-loop', NO_FRESH, withPending, LOOP_DEF)).toBe(
      true,
    )
  })

  test('窗口取值规则：loop 的扫描窗口来自 wrapperProgressJson.iteration，不是 wrapper 行自身 iteration', () => {
    // pending 行落在 wrapper 行自身的 iteration=0（≠ progress 窗口 1）不解锁——
    // 未来 approve 复活修复若铸 pending 行，必须铸在 progress 窗口上才有效。
    const wrongAxis = [
      ...postApproveRows,
      run({ id: '01C', nodeId: 'rev', status: 'pending', iteration: 0 }),
    ]
    expect(wrapperHasFreshInnerWork(parkedLoopRow, wrongAxis, LOOP_DEF)).toBe(false)
    // 而落在 progress 窗口 iteration=1 上的同款 pending 行解锁（上一个用例已证）。
  })
})

describe('S-3 — wrapper-git ∋ review 被 approve 后的 park 死锁（同型）', () => {
  // git wrapper 的 inner 共享 wrapper 行自身的 iteration（dispatchFrontier.ts:98-101）；
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

  test('[S-3 LOCK] approve 后形态 → wrapperHasFreshInnerWork = false 且 isDispatchable = false', () => {
    // 修复时同 loop 组：扩展谓词则翻 true；approve 铸 pending 则本断言保持并
    // 转为谓词契约锁定。
    expect(wrapperHasFreshInnerWork(parkedGitRow, postApproveRows, GIT_DEF)).toBe(false)
    expect(isDispatchable(parkedGitRow, 'wrapper-git', NO_FRESH, postApproveRows, GIT_DEF)).toBe(
      false,
    )
  })

  test('对照组 + 窗口规则：pending 落在 wrapper 自身 iteration=2 解锁；落在 0 不解锁', () => {
    const atOwnIter = [
      ...postApproveRows,
      run({ id: '01C', nodeId: 'rev', status: 'pending', iteration: 2 }),
    ]
    expect(wrapperHasFreshInnerWork(parkedGitRow, atOwnIter, GIT_DEF)).toBe(true)
    expect(isDispatchable(parkedGitRow, 'wrapper-git', NO_FRESH, atOwnIter, GIT_DEF)).toBe(true)

    const atWrongIter = [
      ...postApproveRows,
      run({ id: '01C', nodeId: 'rev', status: 'pending', iteration: 0 }),
    ]
    expect(wrapperHasFreshInnerWork(parkedGitRow, atWrongIter, GIT_DEF)).toBe(false)
  })
})
