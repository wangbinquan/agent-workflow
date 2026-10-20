// RFC-103 T1 (调研报告 01-LIFE-05) — 恢复回滚基线选择回归锁。
//
// 为什么这条测试存在：resumeTask 原本按 (nodeId → 最大 ULID) 取「每节点最新
// run」作为回滚目标，但未排除 fanout/loop 子行（parentNodeRunId !== null）。
// 子行 ULID 可能晚于其节点的 top-level 行，于是冒充节点最新行，resumeTask 用其
// pre_snapshot 回滚到错误（子行）基线。本测试锁定 selectResumeRollbackTargets
// 只取 top-level（parentNodeRunId === null）的 freshest 行，且仅 failed/
// interrupted 终态进集——对齐 freshness.ts pickFreshestRun 的 topLevelOnly。
import { describe, expect, test } from 'bun:test'
import { selectResumeRollbackTargets } from '../src/services/task'

type Row = {
  seq: number | null
  id: string
  nodeId: string
  parentNodeRunId: string | null
  status: string
}

describe('RFC-103 T1 selectResumeRollbackTargets', () => {
  test('fanout 子行（ULID 更大）不冒充节点最新行——只回滚 top-level 父行', () => {
    const rows: Row[] = [
      { seq: null, id: '0001', nodeId: 'A', parentNodeRunId: null, status: 'failed' }, // top-level 父行
      { seq: null, id: '0009', nodeId: 'A', parentNodeRunId: '0001', status: 'failed' }, // shard 子行，ULID 更大
      { seq: null, id: '0010', nodeId: 'A', parentNodeRunId: '0001', status: 'interrupted' },
    ]
    const got = selectResumeRollbackTargets(rows)
    expect(got).toHaveLength(1)
    expect(got[0]!.id).toBe('0001')
    expect(got[0]!.parentNodeRunId).toBeNull()
  })

  test('子行 failed/interrupted 也不进 rollback 集（只 top-level）', () => {
    const rows: Row[] = [
      { seq: null, id: '0002', nodeId: 'B', parentNodeRunId: '00xx', status: 'failed' }, // 仅子行，无 top-level
      { seq: null, id: '0003', nodeId: 'B', parentNodeRunId: '00yy', status: 'interrupted' },
    ]
    expect(selectResumeRollbackTargets(rows)).toHaveLength(0)
  })

  test('top-level 多行取 freshest（最大 ULID）', () => {
    const rows: Row[] = [
      { seq: null, id: '0001', nodeId: 'C', parentNodeRunId: null, status: 'failed' },
      { seq: null, id: '0005', nodeId: 'C', parentNodeRunId: null, status: 'interrupted' }, // freshest
      { seq: null, id: '0003', nodeId: 'C', parentNodeRunId: null, status: 'failed' },
    ]
    const got = selectResumeRollbackTargets(rows)
    expect(got).toHaveLength(1)
    expect(got[0]!.id).toBe('0005')
  })

  test('done/其他终态的 top-level 行不进集（仅 failed/interrupted）', () => {
    const rows: Row[] = [
      { seq: null, id: '0001', nodeId: 'D', parentNodeRunId: null, status: 'done' },
      { seq: null, id: '0002', nodeId: 'E', parentNodeRunId: null, status: 'canceled' },
    ]
    expect(selectResumeRollbackTargets(rows)).toHaveLength(0)
  })

  test('多节点混合：各取自己的 top-level freshest 失败行', () => {
    const rows: Row[] = [
      { seq: null, id: '0001', nodeId: 'A', parentNodeRunId: null, status: 'failed' },
      { seq: null, id: '0002', nodeId: 'A', parentNodeRunId: '0001', status: 'failed' }, // 子行排除
      { seq: null, id: '0003', nodeId: 'B', parentNodeRunId: null, status: 'interrupted' },
      { seq: null, id: '0004', nodeId: 'C', parentNodeRunId: null, status: 'done' }, // 终态排除
    ]
    const got = selectResumeRollbackTargets(rows)
      .map((r) => r.id)
      .sort()
    expect(got).toEqual(['0001', '0003'])
  })
})
