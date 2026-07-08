// RFC-131 T1 — isTargetNodeConsumed 派生式老化判据（design §2）。
//
// 核心正确性：一个 target 队列里、承接 rerun 为 sinceRunId（问题 trigger_run_id）的问题「已被产出老化」
// = 该 (target, iteration) 有 top-level run done + output + 其 id >= sinceRunId（ULID 单调 → 承接 rerun
// 本身或其后产出）。
//   - done-无-output（问下一轮反问）NOT consumed → 不老化、下轮 rerun 继续注入（修多轮丢历史轮 + 天然
//     避免死锁）。
//   - id 序锚（取代脆弱的 startedAt 时间锚：mint 时 startedAt=null、runner spawn 才 set）：一个 node 产出
//     后可以再开新一轮反问（round N+1），那批新问题的承接 rerun id 大于上次产出 run id，不能被上次产出
//     老化——只有「id >= 问题承接 rerun」的产出才老化它。
//   - sinceRunId===null（问题尚未被任何 rerun 承接注入）→ NOT consumed（首次注入）。

import { describe, expect, test } from 'bun:test'

import type { nodeRuns } from '../src/db/schema'
import { isTargetNodeConsumed } from '../src/services/clarifyRerunLedger'

type NodeRunRow = typeof nodeRuns.$inferSelect
const T = 'agent_T'

function mkRun(over: Partial<NodeRunRow>): NodeRunRow {
  return {
    id: 'run',
    nodeId: T,
    iteration: 0,
    parentNodeRunId: null,
    status: 'done',
    startedAt: 1000,
    ...over,
  } as NodeRunRow
}

describe('isTargetNodeConsumed — RFC-131 派生式老化', () => {
  test('done + output（承接 rerun 后产出）→ consumed（老化）', () => {
    expect(
      isTargetNodeConsumed(T, 0, 'r0', [mkRun({ id: 'r1', status: 'done' })], new Set(['r1'])),
    ).toBe(true)
  })

  test('done 无 output（问下一轮反问）→ NOT consumed（不老化、下轮继续注入）', () => {
    expect(
      isTargetNodeConsumed(T, 0, 'r0', [mkRun({ id: 'r1', status: 'done' })], new Set<string>()),
    ).toBe(false)
  })

  test('failed → NOT consumed（revivable）', () => {
    expect(
      isTargetNodeConsumed(T, 0, 'r0', [mkRun({ id: 'r1', status: 'failed' })], new Set(['r1'])),
    ).toBe(false)
  })

  test('pending / running → NOT consumed（在飞）', () => {
    expect(
      isTargetNodeConsumed(T, 0, 'r0', [mkRun({ id: 'r1', status: 'pending' })], new Set(['r1'])),
    ).toBe(false)
    expect(
      isTargetNodeConsumed(T, 0, 'r0', [mkRun({ id: 'r1', status: 'running' })], new Set(['r1'])),
    ).toBe(false)
  })

  test('普通 canceled（非 review-superseded，无 marker）→ NOT consumed', () => {
    expect(
      isTargetNodeConsumed(T, 0, 'r0', [mkRun({ id: 'r1', status: 'canceled' })], new Set(['r1'])),
    ).toBe(false)
  })

  test('review-superseded canceled + output → consumed（design §74 永久老化：reject 把 done+output 翻 canceled 但保留 output）', () => {
    expect(
      isTargetNodeConsumed(
        T,
        0,
        'r0',
        [
          mkRun({
            id: 'r1',
            status: 'canceled',
            supersededByReview: 'rejected',
            errorMessage: 'superseded-by-review-rejected: Replaced by retry_index 1',
          }),
        ],
        new Set(['r1']),
      ),
    ).toBe(true)
  })

  test('sinceRunId===null（未绑承接 rerun）→ NOT consumed（首次注入）', () => {
    expect(
      isTargetNodeConsumed(T, 0, null, [mkRun({ id: 'r1', status: 'done' })], new Set(['r1'])),
    ).toBe(false)
  })

  test('no run → NOT consumed', () => {
    expect(isTargetNodeConsumed(T, 0, 'r0', [], new Set<string>())).toBe(false)
  })

  test('iteration 隔离：done+output 在别的 iteration 不算', () => {
    const runs = [mkRun({ id: 'r1', status: 'done', iteration: 1 })]
    expect(isTargetNodeConsumed(T, 0, 'r0', runs, new Set(['r1']))).toBe(false)
    expect(isTargetNodeConsumed(T, 1, 'r0', runs, new Set(['r1']))).toBe(true)
  })

  test('node 隔离：别的 node done+output 不算', () => {
    expect(
      isTargetNodeConsumed(
        T,
        0,
        'r0',
        [mkRun({ id: 'r1', nodeId: 'other', status: 'done' })],
        new Set(['r1']),
      ),
    ).toBe(false)
  })

  test('fanout 子 run（parentNodeRunId 非 null）done+output 不算（只 top-level 产出）', () => {
    expect(
      isTargetNodeConsumed(
        T,
        0,
        'r0',
        [mkRun({ id: 'r1', status: 'done', parentNodeRunId: 'parent' })],
        new Set(['r1']),
      ),
    ).toBe(false)
  })

  test('混：一个 done-无-output + 一个 done+output → 老化（有产出即可）', () => {
    const runs = [mkRun({ id: 'r1', status: 'done' }), mkRun({ id: 'r2', status: 'done' })]
    expect(isTargetNodeConsumed(T, 0, 'r0', runs, new Set(['r2']))).toBe(true)
  })

  test('id 序：产出 run id < 承接 rerun id → NOT consumed（round N+1 新问题不被旧产出老化）', () => {
    const runs = [mkRun({ id: 'r1', status: 'done' })] // 旧产出 run r1（round N）
    // round N+1 新问题的承接 rerun = r2（id > r1）→ 旧产出 r1 不老化它。
    expect(isTargetNodeConsumed(T, 0, 'r2', runs, new Set(['r1']))).toBe(false)
    // 老问题承接 rerun = r0（id < r1）→ 被 r1 产出老化。
    expect(isTargetNodeConsumed(T, 0, 'r0', runs, new Set(['r1']))).toBe(true)
  })

  // RFC-145：inline 前缀常量随列化退役（isTargetNodeConsumed / isReviewSupersededCanceled
  // 改读 superseded_by_review 列），原「双份同值 parity source-text 锁」失去对象——fork 消亡。
})
