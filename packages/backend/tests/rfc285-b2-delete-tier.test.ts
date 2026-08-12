// RFC-285 T5（B2/D5）—— 删除引用中档统一的删除矩阵（E2/E3）。
//
// 为什么这条测试存在：三类资源对「被任务引用时能否删除」曾三个答案——
// workflow 拒**一切**引用（含终态）、workgroup **零检查**（可删留孤儿）、
// agent 不查任务（快照冻结、天然中档）。B2 统一为中档：**只拒非终态引用**。
//   - workflow 侧红→绿对在 rfc199-workflow-revision.test.ts（running 拒删 →
//     翻 done 后删除成功 + 悬空软链实证——0151 迁移把 tasks.workflow_id 的
//     硬 FK 摘掉，本文件不重复）。
//   - 本文件锁 workgroup 的收紧半边（E3，能力收缩；Q2 现网只读检查结果已记
//     plan.md T5 实施记录）+ 披露聚合 count（沿 workflow.ts task-ACL 论证，
//     不泄他人任务 id/status）。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, users, workgroups } from '../src/db/schema'
import { deleteWorkgroup } from '../src/services/workgroups'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actorOf(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: `u-${id.slice(-6)}`, displayName: 'U', role, status: 'active' },
    source: 'session',
  })
}

async function seed(db: DbClient, ownerId: string): Promise<string> {
  await db.insert(users).values({
    id: ownerId,
    username: `u-${ownerId.slice(-6)}`,
    displayName: 'Owner',
    role: 'user',
    status: 'active',
    passwordHash: 'x',
    createdAt: 1,
    updatedAt: 1,
  })
  const wgId = ulid()
  await db.insert(workgroups).values({
    id: wgId,
    name: `wg-${wgId.toLowerCase()}`,
    mode: 'free_collab',
    ownerUserId: ownerId,
    visibility: 'private',
  })
  return wgId
}

async function seedTaskRef(
  db: DbClient,
  wgId: string,
  // 注意：'interrupted' 在 shared/lifecycle.ts TERMINAL_TASK_STATUSES 里**属
  // 终态**（daemon 重启遗留、可 resume 但记账为终局）——非终态代表取
  // running / awaiting_human。
  status: 'running' | 'done' | 'awaiting_human',
): Promise<string> {
  const id = ulid()
  await db.insert(tasks).values({
    id,
    name: `ref-${status}`,
    workflowId: 'wf-any', // 0151 后软链——无需真实 workflow 行
    workflowSnapshot: '{}',
    repoPath: '/tmp/r',
    worktreePath: '/tmp/w',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status,
    inputs: '{}',
    startedAt: 1,
    workgroupId: wgId,
  })
  return id
}

describe('RFC-285 B2 — workgroup 删除中档（E3 收紧）', () => {
  test('非终态引用（running / awaiting_human）→ 409 workgroup-in-use，披露仅聚合 count', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = 'u_wg_owner1'
    const wgId = await seed(db, owner)
    await seedTaskRef(db, wgId, 'running')
    await seedTaskRef(db, wgId, 'awaiting_human')
    try {
      await deleteWorkgroup(
        db,
        wgId,
        { expectedVersion: 1, clientMutationId: ulid() },
        { kind: 'actor', actor: actorOf(owner) },
      )
      throw new Error('expected workgroup-in-use')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'workgroup-in-use',
        status: 409,
        details: { referenceCount: 2 },
      })
      expect((error as { details?: object }).details).not.toHaveProperty('tasks')
    }
  })

  test('仅终态引用 → 删除成功；任务行存活、workgroupId 悬空（软链现状）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = 'u_wg_owner2'
    const wgId = await seed(db, owner)
    const taskId = await seedTaskRef(db, wgId, 'done')
    await deleteWorkgroup(
      db,
      wgId,
      { expectedVersion: 1, clientMutationId: ulid() },
      { kind: 'actor', actor: actorOf(owner) },
    )
    const wgRows = await db.select().from(workgroups)
    expect(wgRows.length).toBe(0)
    const taskRow = (await db.select().from(tasks)).find((t) => t.id === taskId)
    expect(taskRow?.workgroupId).toBe(wgId) // 悬空软链保留（展示层容忍）
  })

  test('引用翻终态后原被拒的删除转为成功（红→绿对）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = 'u_wg_owner3'
    const wgId = await seed(db, owner)
    const taskId = await seedTaskRef(db, wgId, 'running')
    await expect(
      deleteWorkgroup(
        db,
        wgId,
        { expectedVersion: 1, clientMutationId: ulid() },
        { kind: 'actor', actor: actorOf(owner) },
      ),
    ).rejects.toMatchObject({ code: 'workgroup-in-use' })
    const { eq } = await import('drizzle-orm')
    await db.update(tasks).set({ status: 'canceled' }).where(eq(tasks.id, taskId))
    await deleteWorkgroup(
      db,
      wgId,
      { expectedVersion: 1, clientMutationId: ulid() },
      { kind: 'actor', actor: actorOf(owner) },
    )
    expect((await db.select().from(workgroups)).length).toBe(0)
  })
})
