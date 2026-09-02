// RFC-350 —— 不活跃超时（僵尸任务）判据的纯函数锁。
//
// 为什么这些测试存在：`judgeIdleTree` 是**唯一**决定「一棵树会不会被自动取消」的
// 判据。它判错的代价是不可逆的（进程被杀、任务被终结），所以它的每条边界都在这里
// 用纯数据钉死，不依赖数据库、进程或时钟。
//
// 对应 design.md §9 的 T-1～T-7 与 proposal.md 的 AC-2 / AC-3 / AC-4。

import { describe, expect, test } from 'bun:test'

import {
  IDLE_TIMEOUT_SUMMARY,
  idleTimeoutReason,
  idleTimeoutThresholdMs,
  isReapableStatus,
  judgeIdleTree,
  type TaskActivityRecord,
} from '../src/modules/task-execution/domain/idleTimeoutPolicy'

const HOUR = 3_600_000
const NOW = 1_788_278_400_000
const THRESHOLD = 24 * HOUR

function member(
  taskId: string,
  status: TaskActivityRecord['status'],
  activityAt: number,
): TaskActivityRecord {
  return { taskId, status, activityAt }
}

describe('RFC-350 judgeIdleTree', () => {
  test('T-1 全终态树不归本功能管（那是既有归档保留期的活儿）', () => {
    const verdict = judgeIdleTree({
      rootTaskId: 'root',
      members: [
        member('root', 'done', NOW - 100 * HOUR),
        member('child', 'canceled', NOW - 100 * HOUR),
      ],
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(verdict.idle).toBe(false)
    expect(verdict.liveTaskIds).toEqual([])
  })

  test('T-2 树内任一成员活动新鲜 ⇒ 整棵树都算活着（AC-3）', () => {
    const verdict = judgeIdleTree({
      rootTaskId: 'root',
      // 父任务在 call 节点上等子任务，自己一个事件都没有；子任务刚刚还在干活。
      members: [
        member('root', 'running', NOW - 100 * HOUR),
        member('child', 'running', NOW - 1 * HOUR),
      ],
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(verdict.idle).toBe(false)
    expect(verdict.treeActivityAt).toBe(NOW - 1 * HOUR)
  })

  test('T-3 全员静默超阈值 + 有非终态成员 ⇒ 收，liveTaskIds 恰为可取消成员（AC-2）', () => {
    const verdict = judgeIdleTree({
      rootTaskId: 'root',
      members: [
        member('root', 'running', NOW - 40 * HOUR),
        member('done-child', 'done', NOW - 30 * HOUR),
        member('parked-child', 'awaiting_human', NOW - 50 * HOUR),
      ],
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(verdict.idle).toBe(true)
    expect(verdict.treeActivityAt).toBe(NOW - 30 * HOUR)
    expect(verdict.silentMs).toBe(30 * HOUR)
    expect([...verdict.liveTaskIds].sort()).toEqual(['parked-child', 'root'])
  })

  test('T-4 interrupted 是终态且不可 cancel ⇒ 绝不进 liveTaskIds', () => {
    const verdict = judgeIdleTree({
      rootTaskId: 'root',
      members: [
        member('root', 'running', NOW - 40 * HOUR),
        member('orphaned', 'interrupted', NOW - 40 * HOUR),
      ],
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(verdict.idle).toBe(true)
    expect(verdict.liveTaskIds).toEqual(['root'])
  })

  test('T-4b 整棵树只剩 interrupted ⇒ 本功能不碰（出路是归档器认它为终态）', () => {
    const verdict = judgeIdleTree({
      rootTaskId: 'root',
      members: [member('root', 'interrupted', NOW - 400 * HOUR)],
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(verdict.idle).toBe(false)
  })

  test('T-5 边界严格大于：正好卡在阈值那一刻不收', () => {
    const exactly = judgeIdleTree({
      rootTaskId: 'root',
      members: [member('root', 'running', NOW - THRESHOLD)],
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(exactly.idle).toBe(false)
    const oneMsLater = judgeIdleTree({
      rootTaskId: 'root',
      members: [member('root', 'running', NOW - THRESHOLD - 1)],
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(oneMsLater.idle).toBe(true)
  })

  test('T-6 刚创建的 pending 任务不会被立刻收（AC-4）', () => {
    const verdict = judgeIdleTree({
      rootTaskId: 'fresh',
      members: [member('fresh', 'pending', NOW)],
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(verdict.idle).toBe(false)
    expect(verdict.silentMs).toBe(0)
  })

  test('T-6b 空树与非正阈值一律不收（任何调用方传 0 都不能把全库扫平）', () => {
    expect(
      judgeIdleTree({ rootTaskId: 'x', members: [], now: NOW, thresholdMs: THRESHOLD }).idle,
    ).toBe(false)
    expect(
      judgeIdleTree({
        rootTaskId: 'x',
        members: [member('x', 'running', 0)],
        now: NOW,
        thresholdMs: 0,
      }).idle,
    ).toBe(false)
  })

  test('T-6c 时钟回拨：静默时长归零而不是负数', () => {
    const verdict = judgeIdleTree({
      rootTaskId: 'root',
      members: [member('root', 'running', NOW + 10 * HOUR)],
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(verdict.silentMs).toBe(0)
    expect(verdict.idle).toBe(false)
  })

  test('T-7 树的活动时刻取全体成员的 max，与顺序无关', () => {
    const members = [
      member('a', 'running', NOW - 90 * HOUR),
      member('b', 'done', NOW - 26 * HOUR),
      member('c', 'failed', NOW - 80 * HOUR),
    ]
    const forward = judgeIdleTree({ rootTaskId: 'a', members, now: NOW, thresholdMs: THRESHOLD })
    const reversed = judgeIdleTree({
      rootTaskId: 'a',
      members: [...members].reverse(),
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(forward.treeActivityAt).toBe(NOW - 26 * HOUR)
    expect(reversed.treeActivityAt).toBe(forward.treeActivityAt)
    expect(forward.idle).toBe(true)
  })

  test('可收割状态集恰为「可取消」四态', () => {
    expect(isReapableStatus('pending')).toBe(true)
    expect(isReapableStatus('running')).toBe(true)
    expect(isReapableStatus('awaiting_review')).toBe(true)
    expect(isReapableStatus('awaiting_human')).toBe(true)
    expect(isReapableStatus('interrupted')).toBe(false)
    expect(isReapableStatus('done')).toBe(false)
    expect(isReapableStatus('failed')).toBe(false)
    expect(isReapableStatus('canceled')).toBe(false)
  })
})

describe('RFC-350 阈值换算与原因文案', () => {
  test('小时 → 毫秒，取整', () => {
    expect(idleTimeoutThresholdMs(24)).toBe(24 * HOUR)
    expect(idleTimeoutThresholdMs(1)).toBe(HOUR)
    expect(idleTimeoutThresholdMs(0)).toBe(0)
  })

  test('原因文案带机器 token 与两个时长（前端按 token 取中文文案）', () => {
    const reason = idleTimeoutReason({ silentMs: 30 * HOUR, thresholdMs: 24 * HOUR })
    expect(reason.summary).toBe(IDLE_TIMEOUT_SUMMARY)
    expect(reason.summary).toBe('task-idle-timeout')
    expect(reason.message).toContain(String(30 * HOUR))
    expect(reason.message).toContain(String(24 * HOUR))
  })
})
