// RFC-108 T14 (AR-06) — S6 member-deadlock detection (detect-only, decision D4).
//
// 为什么这条测试存在：一个 awaiting_* 任务若所有成员（属主+协作者）都非活跃，就没人能
// 应答 review/clarify——死锁。本测试锁定 runStuckTaskDetector 的 S6 判定：① 属主被停用
// → S6 告警；② 属主活跃 → 无 S6；③ system-owned（无人类成员边界）→ 无 S6；④ 属主停用
// 但有活跃协作者 → 无 S6（仍有人能应答）。

import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { taskCollaborators, tasks, users, workflows } from '../src/db/schema'
import { taskRecoveryOperations } from './helpers/taskRecoveryOperations'
import { runStuckTaskDetector } from '../src/services/stuckTaskDetector'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedUser(db: DbClient, status: 'active' | 'disabled' | 'invited'): Promise<string> {
  const id = ulid()
  await db.insert(users).values({
    id,
    username: `u_${id}`,
    displayName: 'U',
    status,
    role: 'user',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

async function seedAwaitingTask(db: DbClient, ownerUserId: string | null): Promise<string> {
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
    ownerUserId,
    inputs: '{}',
    startedAt: Date.now() - 60_000,
  })
  return taskId
}

const s6 = (r: { openAlerts: Array<{ taskId: string; rule: string }> }, taskId: string): boolean =>
  r.openAlerts.some((a) => a.taskId === taskId && a.rule === 'S6')

describe('RFC-108 T14 — S6 member-deadlock', () => {
  test('awaiting task whose owner is disabled → S6 alert', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = await seedUser(db, 'disabled')
    const taskId = await seedAwaitingTask(db, owner)
    const r = await runStuckTaskDetector({
      operations: taskRecoveryOperations(db),
      now: () => Date.now(),
    })
    expect(s6(r, taskId)).toBe(true)
  })

  test('awaiting task with an ACTIVE owner → no S6', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = await seedUser(db, 'active')
    const taskId = await seedAwaitingTask(db, owner)
    const r = await runStuckTaskDetector({
      operations: taskRecoveryOperations(db),
      now: () => Date.now(),
    })
    expect(s6(r, taskId)).toBe(false)
  })

  test('system-owned / no human members → no S6 (no membership boundary)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedAwaitingTask(db, '__system__')
    const r = await runStuckTaskDetector({
      operations: taskRecoveryOperations(db),
      now: () => Date.now(),
    })
    expect(s6(r, taskId)).toBe(false)
  })

  test('disabled owner but an ACTIVE collaborator → no S6 (someone can still answer)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = await seedUser(db, 'disabled')
    const collab = await seedUser(db, 'active')
    const taskId = await seedAwaitingTask(db, owner)
    await db.insert(taskCollaborators).values({
      taskId,
      userId: collab,
      role: 'collaborator',
      addedBy: owner,
      addedAt: Date.now(),
    })
    const r = await runStuckTaskDetector({
      operations: taskRecoveryOperations(db),
      now: () => Date.now(),
    })
    expect(s6(r, taskId)).toBe(false)
  })
})
