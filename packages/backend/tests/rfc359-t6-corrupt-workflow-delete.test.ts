// RFC-359 W1-T6（P0-6）—— 定义损坏的工作流必须能删，两个引擎各跑一遍；删除守卫同规则。
//
// dual-provider-parity-audit-2026-09-04 P0-6：SQLite 专设 getWorkflowAclRow / deleteWorkflow 走原始行，
// 「你必须能删掉一个坏掉的工作流」；PG 的 delete 事务第二条语句就是 workflowFromPersistenceRow(row)，
// 坏 JSON ⇒ 422 workflow-definition-corrupt，PG 上没有任何 API 路径能移除它。删除路径现在两侧都只用
// 原始行的 ACL 身份与版本；PG 同时补齐 SQLite 一直有的两道删除守卫（非终态任务引用 / 定时任务引用）。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { scheduledTasks, tasks, users, workflows } from '@/db/schema'
import { describeEachProvider } from './helpers/eachProvider'
import { workflowAuthorityFor, workflowCatalogFor } from './helpers/workflowCatalog'

const OWNER = 'u_t6_owner'

async function seedOwner(db: ProviderNeutralDatabase): Promise<void> {
  await db
    .insert(users)
    .values({
      id: OWNER,
      username: `u-${OWNER}`,
      displayName: OWNER,
      role: 'admin',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    .onConflictDoNothing()
}

async function seedCorruptWorkflow(
  db: ProviderNeutralDatabase,
): Promise<{ id: string; name: string }> {
  const id = `wf_${ulid()}`
  const name = `broken-${id.slice(-6)}`
  await db.insert(workflows).values({
    id,
    name,
    description: '',
    // 不是 JSON：任何解析路径都会 422 workflow-definition-corrupt。
    definition: '{"$schema_version":2,"nodes":[',
    version: 1,
    ownerUserId: OWNER,
    visibility: 'private',
    schemaVersion: 2,
  })
  return { id, name }
}

function deletion(name: string, expectedVersion = 1) {
  return {
    submission: {
      kind: 'json-body' as const,
      body: JSON.stringify({ expectedVersion, clientMutationId: ulid(), confirm: name }),
    },
  }
}

async function workflowExists(db: ProviderNeutralDatabase, id: string): Promise<boolean> {
  return (
    (await db.select({ id: workflows.id }).from(workflows).where(eq(workflows.id, id))).length > 0
  )
}

describeEachProvider('RFC-359 T6 —— 定义损坏的工作流可删（P0-6）', (harness) => {
  test('坏 JSON 定义：owner 走目录删除命令成功，行消失', async () => {
    const db = harness.db
    await seedOwner(db)
    const { id, name } = await seedCorruptWorkflow(db)
    const catalog = workflowCatalogFor(db)
    const receipt = await catalog.operations.delete.invoke(workflowAuthorityFor(OWNER), {
      id,
      ...deletion(name),
    })
    expect(receipt.deletedVersion).toBe(1)
    expect(await workflowExists(db, id)).toBe(false)
  })

  test('版本不匹配：坏定义的行也只报 409 stale，不 422', async () => {
    const db = harness.db
    await seedOwner(db)
    const { id, name } = await seedCorruptWorkflow(db)
    const catalog = workflowCatalogFor(db)
    await expect(
      catalog.operations.delete.invoke(workflowAuthorityFor(OWNER), { id, ...deletion(name, 7) }),
    ).rejects.toMatchObject({ status: 409 })
    expect(await workflowExists(db, id)).toBe(true)
  })

  test('仍被非终态任务引用 ⇒ 409 workflow-in-use（两引擎同一守卫）', async () => {
    const db = harness.db
    await seedOwner(db)
    const { id, name } = await seedCorruptWorkflow(db)
    const taskId = `t6_${ulid()}`
    await db.insert(tasks).values({
      id: taskId,
      name: taskId,
      workflowId: id,
      workflowSnapshot: '{}',
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/worktree',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: 1,
    })
    const catalog = workflowCatalogFor(db)
    await expect(
      catalog.operations.delete.invoke(workflowAuthorityFor(OWNER), { id, ...deletion(name) }),
    ).rejects.toMatchObject({ code: 'workflow-in-use', details: { referenceCount: 1 } })
    // 终态引用不挡删除。
    await db.update(tasks).set({ status: 'done', finishedAt: 2 }).where(eq(tasks.id, taskId))
    await catalog.operations.delete.invoke(workflowAuthorityFor(OWNER), { id, ...deletion(name) })
    expect(await workflowExists(db, id)).toBe(false)
  })

  test('仍是定时任务的启动目标 ⇒ 409 workflow-scheduled-referenced（两引擎同一守卫）', async () => {
    const db = harness.db
    await seedOwner(db)
    const { id, name } = await seedCorruptWorkflow(db)
    const scheduleId = `sched_${ulid()}`
    await db.insert(scheduledTasks).values({
      id: scheduleId,
      name: 'nightly',
      ownerUserId: OWNER,
      launchKind: 'workflow',
      launchPayload: JSON.stringify({ workflowId: id, name: 'nightly-run', inputs: {} }),
      scheduleSpec: JSON.stringify({ kind: 'cron', expression: '0 0 * * *', timezone: 'UTC' }),
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    })
    const catalog = workflowCatalogFor(db)
    await expect(
      catalog.operations.delete.invoke(workflowAuthorityFor(OWNER), { id, ...deletion(name) }),
    ).rejects.toMatchObject({
      code: 'workflow-scheduled-referenced',
      details: { scheduledCount: 1, hiddenCount: 0 },
    })
    await db.delete(scheduledTasks).where(eq(scheduledTasks.id, scheduleId))
    await catalog.operations.delete.invoke(workflowAuthorityFor(OWNER), { id, ...deletion(name) })
    expect(await workflowExists(db, id)).toBe(false)
  })
})
