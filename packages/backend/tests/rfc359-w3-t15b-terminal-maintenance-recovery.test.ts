// RFC-359 W3-T15-B —— 终态维护恢复的其余四步（archive / workspace-gc / webhook prune / legacy pruned），
// 两个引擎各跑一遍。
//
// 此前这四步只有 SQLite 专属实现（services/taskArchive.ts、platform/persistence/sqlite/systemWorkspaceGc.ts），
// PostgreSQL daemon 一步都不跑：崩溃留下的归档 `.tmp-*`、workspace-gc 认领、webhook-terminal 回收认领
// 与 RFC-165 之前被删目录的幽灵工作区在 PG 上永远没人收尾。现在归档恢复是 `TaskArchiveMaintenanceCommand.recover`
// （`.tmp-*` 规则一份实现 archiveTempDirectorySweep.ts），工作区四步是 `WorkspaceMaintenanceCommand.recover`
// 一份实现（boot 用 webhookClaims: 'all' 接管全部认领并回填 legacy tombstone）。场景移植自
// rfc311-task-archive / rfc300-workspace-prune / rfc165-workspace-gc（SQLite 黄金锁仍保留）。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { taskExecutionMaintenanceClaims, tasks, workflows } from '@/db/schema'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import { createTaskArchiveMaintenanceCommand } from '@/modules/task-execution/composition/providerRuntime'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_788_278_400_000

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'aw-rfc359-t15b-'))
}

function archiveDirs(root: string) {
  const dirs = {
    archiveDir: join(root, 'archive', 'tasks'),
    runsDir: join(root, 'runs'),
    logsDir: join(root, 'logs'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  return dirs
}

async function seedTask(
  db: ProviderNeutralDatabase,
  taskId: string,
  over: Partial<typeof tasks.$inferInsert> = {},
): Promise<void> {
  const snapshot = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc359-t15b',
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
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    startedAt: NOW - 10_000,
    finishedAt: NOW - 5_000,
    ...over,
  })
}

async function taskExists(db: ProviderNeutralDatabase, taskId: string): Promise<boolean> {
  return (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).length > 0
}

async function taskRow(db: ProviderNeutralDatabase, taskId: string) {
  return (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
}

describeEachProvider('RFC-359 W3-T15-B —— 归档恢复（archive.recover）', (harness) => {
  test('未认领的 .tmp-*：任务还在 ⇒ 丢弃；任务已删 ⇒ 提升为正式目录', async () => {
    const db = harness.db
    const root = tmpRoot()
    try {
      const dirs = archiveDirs(root)
      const stillHere = `t15b_${ulid()}`
      const gone = `t15b_${ulid()}`
      await seedTask(db, stillHere)
      mkdirSync(join(dirs.archiveDir, `.tmp-${stillHere}`, 'db'), { recursive: true })
      mkdirSync(join(dirs.archiveDir, `.tmp-${gone}`, 'db'), { recursive: true })
      writeFileSync(join(dirs.archiveDir, `.tmp-${gone}`, 'manifest.json'), '{}', 'utf-8')

      const recovered = await createTaskArchiveMaintenanceCommand(db).recover(dirs)
      expect(recovered.promoted).toEqual([gone])
      expect(recovered.discarded).toEqual([stillHere])
      expect(existsSync(join(dirs.archiveDir, gone, 'manifest.json'))).toBe(true)
      expect(existsSync(join(dirs.archiveDir, `.tmp-${stillHere}`))).toBe(false)
      expect(await taskExists(db, stillHere)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('RFC-328 认领停在 io-complete、tmp 已有 manifest ⇒ 提升目录、删库行、认领 completed', async () => {
    const db = harness.db
    const root = tmpRoot()
    try {
      const dirs = archiveDirs(root)
      const taskId = `t15b_${ulid()}`
      await seedTask(db, taskId)
      const maintenance = createTaskExecutionPersistence(db).terminalMaintenance
      const members = await maintenance.snapshotTree(taskId)
      let claim = await maintenance.claim({
        rootTaskId: taskId,
        operation: 'archive',
        members,
        cleanupPlanJson: JSON.stringify({
          v: 2,
          rootTaskId: taskId,
          archiveRoot: dirs.archiveDir,
          runsRoot: dirs.runsDir,
          logsRoot: dirs.logsDir,
        }),
        now: NOW,
      })
      claim = await maintenance.transition({ claim, to: 'io-complete', now: NOW + 1 })
      mkdirSync(join(dirs.archiveDir, `.tmp-${taskId}`, 'db'), { recursive: true })
      writeFileSync(join(dirs.archiveDir, `.tmp-${taskId}`, 'manifest.json'), '{}', 'utf-8')

      const recovered = await createTaskArchiveMaintenanceCommand(db).recover(dirs)
      expect(recovered.promoted).toEqual([taskId])
      expect(existsSync(join(dirs.archiveDir, taskId, 'manifest.json'))).toBe(true)
      expect(await taskExists(db, taskId)).toBe(false)
      const state = (
        await db
          .select({ state: taskExecutionMaintenanceClaims.state })
          .from(taskExecutionMaintenanceClaims)
          .where(eq(taskExecutionMaintenanceClaims.id, claim.claimId))
      )[0]?.state
      expect(state).toBe('completed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describeEachProvider(
  'RFC-359 W3-T15-B —— 工作区恢复（workspaceMaintenance.recover）',
  (harness) => {
    function command(db: ProviderNeutralDatabase, appHome: string) {
      return composeWorkspaceMaintenanceCommand({
        db,
        appHome,
        terminalMaintenance: createTaskExecutionPersistence(db).terminalMaintenance,
        isMaterializingTask: () => false,
        invalidateWorkspacePath() {},
      })
    }

    test('webhook-terminal 认领：ticker 只接管过期租约，boot（webhookClaims: all）接管全部', async () => {
      const db = harness.db
      const appHome = tmpRoot()
      try {
        const taskId = `t15b_${ulid()}`
        const workspace = join(appHome, 'scratch', taskId)
        mkdirSync(workspace, { recursive: true })
        writeFileSync(join(workspace, 'note.txt'), 'x', 'utf-8')
        await seedTask(db, taskId, {
          spaceKind: 'scratch',
          repoPath: workspace,
          worktreePath: workspace,
          eventSubscriptionId: `sub_${taskId}`,
          workspacePruningAt: NOW,
          workspacePruneCause: 'webhook-terminal',
        })
        const maintenance = command(db, appHome)
        // 租约刚盖章，不算过期：默认（ticker 语义）不碰。
        const stale = await maintenance.recover({ activeTaskIds: [], now: NOW + 1_000 })
        expect(stale).toEqual({ completed: 0, failed: 0, skipped: 0, healed: 0 })
        expect(existsSync(workspace)).toBe(true)
        // boot 接管全部认领：删目录、盖 workspace_pruned_at。
        const boot = await maintenance.recover({
          activeTaskIds: [],
          webhookClaims: 'all',
          now: NOW + 2_000,
        })
        expect(boot).toMatchObject({ completed: 1, failed: 0, healed: 0 })
        expect(existsSync(workspace)).toBe(false)
        expect((await taskRow(db, taskId)).workspacePrunedAt).toBe(NOW + 2_000)
      } finally {
        rmSync(appHome, { recursive: true, force: true })
      }
    })

    test('RFC-165 之前被删目录的终态任务：回填 workspace_pruned_at，第二次不重复', async () => {
      const db = harness.db
      const appHome = tmpRoot()
      try {
        const taskId = `t15b_${ulid()}`
        await seedTask(db, taskId, {
          spaceKind: 'scratch',
          worktreePath: join(appHome, 'vanished', taskId),
        })
        const maintenance = command(db, appHome)
        const first = await maintenance.recover({ activeTaskIds: [], now: NOW + 1_000 })
        expect(first).toMatchObject({ healed: 1 })
        expect((await taskRow(db, taskId)).workspacePrunedAt).toBe(NOW + 1_000)
        const second = await maintenance.recover({ activeTaskIds: [], now: NOW + 2_000 })
        expect(second).toMatchObject({ healed: 0 })
        expect((await taskRow(db, taskId)).workspacePrunedAt).toBe(NOW + 1_000)
      } finally {
        rmSync(appHome, { recursive: true, force: true })
      }
    })

    test('目录还在的终态任务不会被当成幽灵回填', async () => {
      const db = harness.db
      const appHome = tmpRoot()
      try {
        const taskId = `t15b_${ulid()}`
        const workspace = join(appHome, 'alive', taskId)
        mkdirSync(workspace, { recursive: true })
        await seedTask(db, taskId, { spaceKind: 'scratch', worktreePath: workspace })
        const receipt = await command(db, appHome).recover({ activeTaskIds: [], now: NOW + 1_000 })
        expect(receipt).toMatchObject({ healed: 0 })
        expect((await taskRow(db, taskId)).workspacePrunedAt).toBeNull()
        expect(existsSync(workspace)).toBe(true)
      } finally {
        rmSync(appHome, { recursive: true, force: true })
      }
    })
  },
)
