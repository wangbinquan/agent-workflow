// RFC-359 W1-T7c —— 任务删除认领的崩溃恢复，两个引擎各跑一遍。
//
// dual-provider-parity-audit-2026-09-04 T7c：`recoverInterruptedTaskDeletes` 形参是
// `LegacySqliteTaskDatabase`（dbTxSync + SQLite 递归 CTE + 同步 store），PostgreSQL daemon 就算修好
// 启动序列也接不上——崩溃留下的 delete 认领在 PG 上永远没人续做。恢复现在是
// `infrastructure/taskDeleteRecovery.ts` 一份实现，认领的事务内 CAS 是
// `infrastructure/terminalMaintenanceClaim.ts` 一份实现；场景移植自 rfc328-durable-ownership
// 的 SQLite 黄金锁（仍保留），并补齐 claimed / recovery-required / 计划损坏 / 树变化 / 清理挂起分支。

import { expect, test } from 'bun:test'
import { and, eq, isNull } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  taskExecutionMaintenanceClaims,
  taskExecutionMaintenanceMembers,
  tasks,
  workflows,
} from '@/db/schema'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { recoverInterruptedTaskDeletes } from '@/modules/task-execution/infrastructure/taskDeleteRecovery'
import { describeEachProvider } from './helpers/eachProvider'

async function seedTask(
  db: ProviderNeutralDatabase,
  taskId: string,
  over: { readonly parentTaskId?: string; readonly status?: 'done' | 'running' } = {},
): Promise<void> {
  const snapshot = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc359-t7c',
    description: '',
    definition: snapshot,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `wf_${taskId}`,
    workflowSnapshot: snapshot,
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: over.status ?? 'done',
    inputs: '{}',
    startedAt: 1,
    finishedAt: 2,
    ...(over.parentTaskId === undefined ? {} : { parentTaskId: over.parentTaskId }),
  })
}

function plan(taskId: string, over: Partial<Record<'worktrees', unknown>> = {}): string {
  return JSON.stringify({
    v: 2,
    taskId,
    parentTaskId: null,
    worktrees: over.worktrees ?? [],
    directories: [],
  })
}

async function claimTree(db: ProviderNeutralDatabase, rootTaskId: string, cleanupPlanJson: string) {
  const persistence = createTaskExecutionPersistence(db)
  const members = await persistence.terminalMaintenance.snapshotTree(rootTaskId)
  const claim = await persistence.terminalMaintenance.claim({
    rootTaskId,
    operation: 'delete',
    members,
    cleanupPlanJson,
    now: 50,
  })
  return { persistence, members, claim }
}

async function claimState(db: ProviderNeutralDatabase, claimId: string) {
  return (
    await db
      .select({ state: taskExecutionMaintenanceClaims.state })
      .from(taskExecutionMaintenanceClaims)
      .where(eq(taskExecutionMaintenanceClaims.id, claimId))
  )[0]?.state
}

async function taskExists(db: ProviderNeutralDatabase, taskId: string): Promise<boolean> {
  return (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).length > 0
}

describeEachProvider('RFC-359 T7c —— 删除认领崩溃恢复', (harness) => {
  test('io-complete 之后崩溃 → 恢复删掉整棵树、认领 completed、成员占位释放', async () => {
    const db = harness.db
    const root = `t7c_${ulid()}`
    const child = `${root}_child`
    await seedTask(db, root)
    await seedTask(db, child, { parentTaskId: root })
    const { persistence, claim } = await claimTree(db, root, plan(root))
    await persistence.terminalMaintenance.transition({ claim, to: 'io-complete', now: 51 })

    expect(await recoverInterruptedTaskDeletes(db)).toEqual({
      completed: [root],
      cleanupPending: [],
      recoveryRequired: [],
    })
    expect(await taskExists(db, root)).toBe(false)
    expect(await taskExists(db, child)).toBe(false)
    expect(await claimState(db, claim.claimId)).toBe('completed')
    const active = await db
      .select({ taskId: taskExecutionMaintenanceMembers.taskId })
      .from(taskExecutionMaintenanceMembers)
      .where(
        and(
          eq(taskExecutionMaintenanceMembers.claimId, claim.claimId),
          isNull(taskExecutionMaintenanceMembers.releasedAt),
        ),
      )
    expect(active).toHaveLength(0)
  })

  test('还停在 claimed（IO 前崩溃）→ 先推到 io-complete 再收尾', async () => {
    const db = harness.db
    const root = `t7c_${ulid()}`
    await seedTask(db, root)
    const { claim } = await claimTree(db, root, plan(root))
    expect(await recoverInterruptedTaskDeletes(db)).toEqual({
      completed: [root],
      cleanupPending: [],
      recoveryRequired: [],
    })
    expect(await taskExists(db, root)).toBe(false)
    expect(await claimState(db, claim.claimId)).toBe('completed')
  })

  test('recovery-required 且行已不在 → 视作 db-finalized 直接清理收尾', async () => {
    const db = harness.db
    const root = `t7c_${ulid()}`
    await seedTask(db, root)
    const { persistence, claim } = await claimTree(db, root, plan(root))
    await persistence.terminalMaintenance.transition({ claim, to: 'recovery-required', now: 51 })
    await db.delete(tasks).where(eq(tasks.id, root))
    expect(await recoverInterruptedTaskDeletes(db)).toEqual({
      completed: [root],
      cleanupPending: [],
      recoveryRequired: [],
    })
    expect(await claimState(db, claim.claimId)).toBe('completed')
  })

  test('清理计划损坏 → 认领进 recovery-required，再跑一次不重复转移', async () => {
    const db = harness.db
    const root = `t7c_${ulid()}`
    await seedTask(db, root)
    const { claim } = await claimTree(db, root, '{"v":9}')
    expect(await recoverInterruptedTaskDeletes(db)).toEqual({
      completed: [],
      cleanupPending: [],
      recoveryRequired: [root],
    })
    expect(await claimState(db, claim.claimId)).toBe('recovery-required')
    expect(await taskExists(db, root)).toBe(true)
    expect((await recoverInterruptedTaskDeletes(db)).recoveryRequired).toEqual([root])
    expect(await claimState(db, claim.claimId)).toBe('recovery-required')
  })

  test('认领后树变了（多出一个子任务）→ ConflictError，行原样保留', async () => {
    const db = harness.db
    const root = `t7c_${ulid()}`
    await seedTask(db, root)
    const { persistence, claim } = await claimTree(db, root, plan(root))
    await persistence.terminalMaintenance.transition({ claim, to: 'io-complete', now: 51 })
    await seedTask(db, `${root}_late`, { parentTaskId: root })
    await expect(recoverInterruptedTaskDeletes(db)).rejects.toMatchObject({
      code: 'task-terminal-maintenance-conflict',
    })
    expect(await taskExists(db, root)).toBe(true)
    expect(await claimState(db, claim.claimId)).toBe('io-complete')
  })

  test('磁盘清理失败 → 行已删、认领停在 cleanup-pending 等下次', async () => {
    const db = harness.db
    const root = `t7c_${ulid()}`
    await seedTask(db, root)
    const missingRepo = `/nonexistent/aw-rfc359-t7c-${ulid()}`
    const { claim } = await claimTree(
      db,
      root,
      plan(root, {
        worktrees: [{ repoPath: missingRepo, worktreePath: `${missingRepo}/wt` }],
      }),
    )
    expect(await recoverInterruptedTaskDeletes(db)).toEqual({
      completed: [],
      cleanupPending: [root],
      recoveryRequired: [],
    })
    expect(await taskExists(db, root)).toBe(false)
    expect(await claimState(db, claim.claimId)).toBe('cleanup-pending')
  })
})

test('源码锁：PG daemon 在可用性闸之后、HTTP 之前续做 delete 认领；services/taskDelete 只再导出', () => {
  const src = resolve(import.meta.dir, '..', 'src')
  const daemon = readFileSync(resolve(src, 'cli', 'postgresqlDaemonApplication.ts'), 'utf8')
  const gate = daemon.indexOf('skillCatalogBoot.activateAvailabilityGate()')
  const recovery = daemon.indexOf('await recoverInterruptedTaskDeletes(input.db)', gate)
  const httpCreate = daemon.indexOf('const app = createComposedApp', recovery)
  expect(gate).toBeGreaterThan(-1)
  expect(recovery).toBeGreaterThan(gate)
  expect(httpCreate).toBeGreaterThan(recovery)
  const service = readFileSync(resolve(src, 'services', 'taskDelete.ts'), 'utf8')
  expect(service).toContain("from '@/modules/task-execution/infrastructure/taskDeleteRecovery'")
  expect(service).not.toContain('export async function recoverInterruptedTaskDeletes(')
})
