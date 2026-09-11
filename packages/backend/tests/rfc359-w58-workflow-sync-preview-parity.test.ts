// RFC-359 W58 —— 工作流同步预览的两条判据：两个 provider 必须给同一个答案。
//
// 为什么这条测试存在（`rfc109-sync-route` 迁成双引擎当天红出来的两条）：
//
// ① **内置工作流**。SQLite 侧 `computeWorkflowSyncPreview` 一上来就看 `workflow.builtin`，
//    回 `builtin-workflow`——RFC-104 下内置工作流永远不能被手动 sync，前端据此隐藏同步横幅
//    （Codex impl-gate F4）。PostgreSQL 侧压根不看这一列，而它装载工作流走的是**可启动性**
//    授权，内置工作流在那里就被挡下，异常被兜成 `workflow-deleted`：横幅上写的是「工作流已被
//    删除」，而工作流好端端地在那儿。
//
// ② **可同步与否**。SQLite 侧看的是**持久化**的任务状态（`allowedFromForTaskEvent`）与工作树；
//    PostgreSQL 侧看的是**进程内**活跃表 `activity.isActive`。于是一个持久化状态就是 `running`
//    的任务——守护进程刚重启、或任务由另一个进程在跑——在 PG 上预览成 `syncable: true`，而真
//    点下去，`syncWorkflow` 用的又是状态判据，稳定 409 `task-not-syncable`。
//
// 两条判据现在都只有一份实现，在 `domain/workflowSyncPreview.ts`。行为面的双引擎覆盖在
// `rfc109-sync-route.test.ts`；这里锁纯函数契约与「不许再各写一份」。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Task } from '@agent-workflow/shared'

import {
  builtinWorkflowSyncPreview,
  notSyncableWorkflowPreview,
  workflowSyncGateReason,
} from '@/modules/task-execution/domain/workflowSyncPreview'

const TASK = {
  workflowId: 'wf-1',
  workflowName: 'wf',
  workflowVersion: 1,
} as unknown as Task

describe('RFC-359 W58 —— 可同步判据（纯函数）', () => {
  test('终态任务 + 工作树在 ⇒ ok', () => {
    expect(workflowSyncGateReason({ status: 'failed', worktreeMissing: false })).toBe('ok')
    expect(workflowSyncGateReason({ status: 'done', worktreeMissing: false })).toBe('ok')
  })

  test('非终态任务 ⇒ task-active（判据是**持久化状态**，不是进程内活跃表）', () => {
    expect(workflowSyncGateReason({ status: 'running', worktreeMissing: false })).toBe(
      'task-active',
    )
    expect(workflowSyncGateReason({ status: 'pending', worktreeMissing: false })).toBe(
      'task-active',
    )
  })

  test('工作树没了 ⇒ worktree-missing，且它盖过 task-active（与 SQLite 侧原有次序一致）', () => {
    expect(workflowSyncGateReason({ status: 'failed', worktreeMissing: true })).toBe(
      'worktree-missing',
    )
    expect(workflowSyncGateReason({ status: 'running', worktreeMissing: true })).toBe(
      'worktree-missing',
    )
  })
})

describe('RFC-359 W58 —— 内置工作流的预览投影（纯函数）', () => {
  test('理由是 builtin-workflow、不可同步、不显示差异', () => {
    const preview = builtinWorkflowSyncPreview(TASK, 7)
    expect(preview.reason).toBe('builtin-workflow')
    expect(preview.syncable).toBe(false)
    expect(preview.differs).toBe(false)
    expect(preview.invalid).toBe(false)
  })

  test('与通用否定投影只差 latestVersion：上游版本号照给（前端仍显示「已到 vN」）', () => {
    expect(builtinWorkflowSyncPreview(TASK, 7)).toEqual({
      ...notSyncableWorkflowPreview(TASK, 'builtin-workflow'),
      latestVersion: 7,
    })
    expect(notSyncableWorkflowPreview(TASK, 'builtin-workflow').latestVersion).toBeNull()
  })
})

describe('RFC-359 W58 —— 两个 provider 都从共用判据取（源代码层兜底）', () => {
  const read = (relative: string): string =>
    readFileSync(resolve(import.meta.dir, '..', 'src', relative), 'utf8')
  const postgresql = read('modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts')
  const sqlite = read('services/task.ts')

  test('PostgreSQL 的预览接了两条共用判据', () => {
    expect(
      postgresql,
      'PG 的预览又不看 `workflows.builtin` 了 ⇒ 内置工作流的任务会拿到 workflow-deleted。',
    ).toContain('builtinWorkflowSyncPreview(')
    expect(postgresql, 'PG 的预览又只看进程内活跃表了 ⇒ 横幅说能同步、按钮必然 409。').toContain(
      'workflowSyncGateReason(',
    )
  })

  test('SQLite 的预览接的是同两条（不是又抄了一份）', () => {
    expect(sqlite).toContain('builtinWorkflowSyncPreview(')
    expect(sqlite).toContain('workflowSyncGateReason(')
    expect(sqlite, 'SQLite 侧又把可同步判据内联回去了：两份实现必然再次漂移。').not.toMatch(
      /const\s+statusSyncable\s*=/,
    )
  })
})
