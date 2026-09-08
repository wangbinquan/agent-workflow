// RFC-108 T22 (AR-11) — listTasks surfaces openAlertCount for the stuck badge.
//
// 为什么这条测试存在：任务列表行的 stuck 徽标靠 TaskSummary.openAlertCount，且必须用
// 一条 grouped 查询（非 per-row fetch）。本测试锁定：① 有未决告警的任务 count>0；②
// 无告警的任务 count=0；③ 已 resolved 的告警不计入。

import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '../src/db/query'
import { lifecycleAlerts, tasks, workflows } from '../src/db/schema'
import { listTaskItems, listTasks } from '../src/services/task'

import { describeEachProvider } from './helpers/eachProvider'

async function seedTask(db: ProviderNeutralDatabase): Promise<string> {
  const wfId = ulid()
  const taskId = ulid()
  const def = { $schema_version: 1, inputs: [], nodes: [], edges: [] }
  await db.insert(workflows).values({ id: wfId, name: 'w', definition: JSON.stringify(def) })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp',
    worktreePath: '/tmp',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now(),
    // Preserve the row and JSON bytes previously filled by SQLite migration 0210.
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
  })
  return taskId
}

async function addAlert(
  db: ProviderNeutralDatabase,
  taskId: string,
  resolved: boolean,
): Promise<void> {
  await db.insert(lifecycleAlerts).values({
    id: ulid(),
    taskId,
    rule: 'S6',
    severity: 'warning',
    detail: '{}',
    detectedAt: Date.now(),
    resolvedAt: resolved ? Date.now() : null,
  })
}

describeEachProvider('RFC-108 T22 — listTasks openAlertCount', (harness) => {
  test('counts only OPEN alerts per task; tasks without alerts → 0', async () => {
    const db = harness.db
    const stuck = await seedTask(db)
    const healthy = await seedTask(db)
    await addAlert(db, stuck, false) // open
    await addAlert(db, stuck, false) // open → 2
    await addAlert(db, stuck, true) // resolved → not counted
    await addAlert(db, healthy, true) // resolved only → 0

    const list = await listTasks(db)
    const byId = new Map(list.map((s) => [s.id, s.openAlertCount ?? 0]))
    expect(byId.get(stuck)).toBe(2)
    expect(byId.get(healthy)).toBe(0)

    const ownerRows = await listTaskItems(db)
    const ownerById = new Map(ownerRows.map((s) => [s.id, s.openAlertCount ?? 0]))
    expect(ownerById).toEqual(byId)
  })
})
