// RFC-357 PR-4 —— 任务列表按帧就地更新的判据。
//
// 为什么这条测试存在：`useTaskOperationsSync` 此前每收到一帧任务级事件就让整棵
// `['task-operations']` 缓存失效、把已加载的每一页重取一遍；1 秒合并窗口只是把上限压到
// 每秒一次。现在 `task.status` / `task.deleted` 先就地应用，屏幕在帧到达的那一刻就对，
// 权威重取因此可以稀疏一个量级（合并窗口 1s → 10s）。
//
// 判据的重点在**边界**，不在「能改一行」：
//   · 不相关的帧不能把缓存标脏（返回 null ⇒ 调用方不写回 ⇒ 不触发无谓重渲染）；
//   · 四个页签计数**不许**被就地算——它的分母含当前页看不见的行与子行，缓存里没有；
//     用户 2026-09-04 报的第一个问题就是「页签数字乱跳」，拿会漂的数字换延迟是倒退；
//   · 状态没变的帧同样不写回（重复帧不该引起重渲染）。

import { describe, expect, it } from 'vitest'

import {
  applyTaskListFrame,
  isPatchableTaskListFrame,
  type TaskListPages,
} from '@/hooks/taskListFrames'
import { TASK_LIST_COALESCE_MS } from '@/hooks/useTaskOperationsSync'
import type { TaskCatalogListItem, TaskCatalogPage, TaskStatus } from '@agent-workflow/shared'

function item(id: string, status: TaskStatus): TaskCatalogListItem {
  return {
    id,
    sourceId: 'workflow',
    title: id,
    subject: { resourceId: 'wf1', label: { 'zh-CN': 'wf', 'en-US': 'wf' } },
    targetLabel: 'repo',
    status,
    statusDetail: null,
    startedAt: 1,
    updatedAt: 1,
    finishedAt: null,
    executionClock: { runningMs: 0, runningSince: null },
    ownerUserId: null,
    owner: null,
    ownerLabel: null,
    errorSummary: null,
    failureCode: null,
    childCount: 0,
    repositoryCount: 1,
    scheduledTaskId: null,
    openAlertCount: 0,
    hierarchy: {
      parentItemId: null,
      invocationDepth: 0,
      matchKind: 'self',
      parentAvailability: 'none',
      qualifyingChildCount: 0,
      matchingDescendantCount: 0,
      branchStartedAt: 1,
    },
  } as TaskCatalogListItem
}

const FACETS = { all: 7, active: 3, attention: 2, finished: 4 }

function page(...items: TaskCatalogListItem[]): TaskCatalogPage {
  return {
    schemaVersion: 1,
    sourceIds: ['workflow'],
    items,
    nextCursor: null,
    facets: FACETS,
  } as TaskCatalogPage
}

function pages(...list: TaskCatalogPage[]): TaskListPages {
  return { pages: list, pageParams: list.map(() => null) }
}

describe('RFC-357 applyTaskListFrame', () => {
  it('updates the status of the matching row, on whichever loaded page it sits', () => {
    const data = pages(page(item('a', 'running')), page(item('b', 'running'), item('c', 'done')))
    const next = applyTaskListFrame(data, { type: 'task.status', taskId: 'b', status: 'failed' })
    expect(next).not.toBeNull()
    expect(next!.pages[1]!.items.map((row) => [row.id, row.status])).toEqual([
      ['b', 'failed'],
      ['c', 'done'],
    ])
    // 第一页没被碰过：同一个对象引用，React 因此不会重渲染它。
    expect(next!.pages[0]).toBe(data.pages[0])
  })

  it('removes the row on task.deleted', () => {
    const data = pages(page(item('a', 'running'), item('b', 'done')))
    const next = applyTaskListFrame(data, { type: 'task.deleted', taskId: 'a' })
    expect(next!.pages[0]!.items.map((row) => row.id)).toEqual(['b'])
  })

  it('returns null when the frame does not touch this cache — no needless invalidation', () => {
    const data = pages(page(item('a', 'running')))
    expect(
      applyTaskListFrame(data, { type: 'task.status', taskId: 'zz', status: 'done' }),
    ).toBeNull()
    expect(applyTaskListFrame(data, { type: 'task.deleted', taskId: 'zz' })).toBeNull()
    // 状态没变的重复帧同样不写回。
    expect(
      applyTaskListFrame(data, { type: 'task.status', taskId: 'a', status: 'running' }),
    ).toBeNull()
  })

  it('never recomputes the tab counts locally — they stay whatever the server last said', () => {
    const data = pages(page(item('a', 'running'), item('b', 'done')))
    const statusPatched = applyTaskListFrame(data, {
      type: 'task.status',
      taskId: 'a',
      status: 'failed',
    })
    const deletePatched = applyTaskListFrame(data, { type: 'task.deleted', taskId: 'a' })
    // facets 的分母是「所有非-view 匹配行」，含当前页看不见的行与子行——缓存里没有，
    // 就地加减必然在一部分情况下算错。数字只由服务端给。
    expect(statusPatched!.pages[0]!.facets).toEqual(FACETS)
    expect(deletePatched!.pages[0]!.facets).toEqual(FACETS)
  })

  it('leaves every other field of the patched row untouched', () => {
    const original = item('a', 'running')
    const data = pages(page(original))
    const next = applyTaskListFrame(data, { type: 'task.status', taskId: 'a', status: 'done' })
    const patched = next!.pages[0]!.items[0]!
    expect(patched).toEqual({ ...original, status: 'done' })
  })
})

describe('RFC-357 which frames can be applied in place at all', () => {
  it('accepts exactly the two frames whose payload is sufficient', () => {
    expect(isPatchableTaskListFrame({ type: 'task.status' })).toBe(true)
    expect(isPatchableTaskListFrame({ type: 'task.deleted' })).toBe(true)
    // 这些算不出来：新行是否命中当前 filters/scope/view、成员变更后的可见性、
    // `lifecycle.alert.resolved` 之后还剩几条告警——只有服务端知道。
    for (const type of [
      'task.created',
      'task.members.changed',
      'employee-case.members.changed',
      'lifecycle.alert',
      'lifecycle.alert.resolved',
    ]) {
      expect(isPatchableTaskListFrame({ type })).toBe(false)
    }
  })
})

describe('RFC-357 the authoritative refetch is sparse, not gone', () => {
  it('coalesces the task list an order of magnitude slower than the default surface', () => {
    // 就地更新只是掩盖重取的延迟，不是取代它。窗口放慢的前提是屏幕已经对了。
    expect(TASK_LIST_COALESCE_MS).toBe(10_000)
    expect(TASK_LIST_COALESCE_MS).toBeGreaterThanOrEqual(10 * 1_000)
  })
})
