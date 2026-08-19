// RFC-311 实现门 P1-6 / P2-3 —— `tasks.branch_started_at` 的维护面。
//
// 该列是 /api/tasks/page 默认视图(快路径)的排序键,语义是「子树 max(started_at)」。
// 变异检验发现两件事:
//   ① 把 task.ts 的父链传播整段短路后,47 个既有用例仍全绿——真启动路径造出来的
//      父子任务从没有人断言过父行被抬升(rfc311 的两个文件都是跑 migration 回填
//      语句造数据);
//   ② 删掉一个终态子任务后,父行**永久**停在被删子树的时间戳上——同一份数据在
//      默认视图与任一过滤视图之间行序不同且永不收敛(design §4.1 承诺的 invariants
//      自愈规则尚未实现,所以没有任何兜底)。
// 这里用真启动路径 + 真删除路径把两件事都锁住。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { StartTask } from '@agent-workflow/shared'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, users, workflows } from '../src/db/schema'
import { __setActiveTaskForTesting, startTask, type MaterializedSpace } from '../src/services/task'
import { deleteTask } from '../src/services/taskDelete'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const EMPTY_DEF = JSON.stringify({ $schema_version: 4, inputs: [], nodes: [], edges: [] })

async function branchStartedAt(db: DbClient, id: string): Promise<number> {
  const row = await db
    .select({ v: tasks.branchStartedAt, started: tasks.startedAt })
    .from(tasks)
    .where(eq(tasks.id, id))
    .get()
  return row?.v ?? -1
}

function spaceFor(taskId: string, root: string): MaterializedSpace {
  return {
    kind: 'single',
    spaceKind: 'inherited',
    taskId,
    worktreePath: root,
    branch: `agent-workflow/${taskId}`,
    baseCommit: null,
    earlyError: null,
    resolvedSources: [
      {
        repoPath: root,
        baseBranch: 'main',
        repoUrl: null,
        cachedRepoId: null,
        pathFetchError: null,
        ffWarnings: [],
      },
    ],
    repos: [
      {
        repoIndex: 0,
        repoPath: root,
        worktreePath: root,
        baseBranch: 'main',
        branch: `agent-workflow/${taskId}`,
        baseCommit: null,
        repoUrl: null,
        cachedRepoId: null,
        mountPath: '',
        subdir: '',
        readonly: false,
        submoduleInitOk: true,
        submoduleInitError: null,
        hasSubmodules: false,
      },
    ],
    nodePaths: [],
    cleanup: { taskId, ownedRoot: null, worktrees: [], state: 'owned', report: null },
  } as unknown as MaterializedSpace
}

describe('RFC-311 — branch_started_at is maintained by the real paths', () => {
  test('a child launched through startTask lifts its ancestors, and deleting it converges them back', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const now = Date.now()
    await db.insert(users).values({
      id: 'u1',
      username: 'u1',
      displayName: 'u1',
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    })
    const wf = ulid()
    await db.insert(workflows).values({ id: wf, name: `wf-${wf.slice(-6)}`, definition: EMPTY_DEF })

    const parentId = ulid()
    const parentStartedAt = now - 60_000
    await db.insert(tasks).values({
      id: parentId,
      name: 'parent',
      workflowId: wf,
      workflowSnapshot: EMPTY_DEF,
      repoPath: '/tmp/never-read',
      worktreePath: '/tmp/never-read',
      baseBranch: 'main',
      branch: `agent-workflow/${parentId}`,
      status: 'running',
      inputs: '{}',
      startedAt: parentStartedAt,
      runningMs: 0,
      ownerUserId: 'u1',
      launchOrigin: 'manual',
      branchStartedAt: parentStartedAt,
    })
    const callRun = ulid()
    await db.insert(nodeRuns).values({
      id: callRun,
      taskId: parentId,
      nodeId: 'n1',
      status: 'running',
      startedAt: parentStartedAt,
    })

    // ① 真启动路径:子任务的 started_at 晚于父,父行必须被抬升到子的时间。
    const childRoot = mkdtempSync(join(tmpdir(), 'aw-rfc311-branch-'))
    let childId: string
    try {
      const started = await startTask({ workflowId: wf, name: 'child', inputs: {} } as StartTask, {
        db,
        materializedSpace: spaceFor('placeholder', childRoot),
        callLaunch: {
          parentTaskId: parentId,
          parentNodeRunId: callRun,
          invocationDepth: 1,
          frozenSnapshotJson: EMPTY_DEF,
          refClosureJson: null,
        },
      })
      childId = started.id
      const childBranch = await branchStartedAt(db, childId)
      const parentAfterLaunch = await branchStartedAt(db, parentId)
      expect(childBranch).toBeGreaterThan(parentStartedAt)
      // 关键:父行被子任务抬升(变异把这段传播短路后,这里会退回 parentStartedAt)。
      expect(parentAfterLaunch).toBe(childBranch)

      // ② 真删除路径:删掉子任务后父行必须收敛回自己的 started_at,
      // 否则默认视图(物化列)与过滤视图(现算)会永远给出不同行序。
      await db
        .update(tasks)
        .set({ status: 'done', finishedAt: Date.now() })
        .where(eq(tasks.id, childId))
      // startTask 注册了活动任务(真实路径的副作用),删除前解除——这里要测的是
      // 删除对物化列的影响,不是活动闸门。
      // 删子任务要求父也已终态(deleteTask 的既有闸门)——正是报告里的场景:
      // 「两者终态后管理员删掉 C」。
      await db
        .update(tasks)
        .set({ status: 'done', finishedAt: Date.now() })
        .where(eq(tasks.id, parentId))
      __setActiveTaskForTesting(undefined)
      await deleteTask(db, childId)
      expect(await branchStartedAt(db, parentId)).toBe(parentStartedAt)
    } finally {
      rmSync(childRoot, { recursive: true, force: true })
    }
  })

  // RFC-311 G1 —— root_task_id 由同一个铸行点一次写定。它是过滤视图快路径的
  // 分组键:写错 = 该任务从此挂在错误的分支下(或自成一根),而 parent_task_id
  // 铸行后不可变,所以这一列此后没有任何路径会修正它。
  test('root_task_id is stamped through the real launch path and chains across depths', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const now = Date.now()
    await db.insert(users).values({
      id: 'u1',
      username: 'u1',
      displayName: 'u1',
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    })
    const wf = ulid()
    await db.insert(workflows).values({ id: wf, name: `wf-${wf.slice(-6)}`, definition: EMPTY_DEF })

    const rootDir = mkdtempSync(join(tmpdir(), 'aw-rfc311-root-'))
    try {
      // 顶层任务:根是自己。
      const rootId = ulid()
      const root = await startTask({ workflowId: wf, name: 'root', inputs: {} } as StartTask, {
        db,
        materializedSpace: spaceFor(rootId, rootDir),
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
      })
      expect(await rootTaskIdOf(db, root.id)).toBe(root.id)

      // 子任务的铸行闸门要求父处于 running(既有语义,与本测试无关)。
      const markRunning = async (taskId: string): Promise<void> => {
        await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId))
      }
      const runOf = async (taskId: string): Promise<string> => {
        const id = ulid()
        await db.insert(nodeRuns).values({
          id,
          taskId,
          nodeId: 'n1',
          status: 'running',
          startedAt: Date.now(),
        })
        return id
      }

      await markRunning(root.id)
      const childId = ulid()
      const child = await startTask({ workflowId: wf, name: 'child', inputs: {} } as StartTask, {
        db,
        materializedSpace: spaceFor(childId, rootDir),
        callLaunch: {
          parentTaskId: root.id,
          parentNodeRunId: await runOf(root.id),
          invocationDepth: 1,
          frozenSnapshotJson: EMPTY_DEF,
          refClosureJson: null,
        },
      })
      expect(await rootTaskIdOf(db, child.id)).toBe(root.id)

      // 孙子:继承的是**父的根**,而不是父自己——两者只在深度 ≥2 时才分得开。
      await markRunning(child.id)
      const grandchild = await startTask(
        { workflowId: wf, name: 'grandchild', inputs: {} } as StartTask,
        {
          db,
          materializedSpace: spaceFor(ulid(), rootDir),
          callLaunch: {
            parentTaskId: child.id,
            parentNodeRunId: await runOf(child.id),
            invocationDepth: 2,
            frozenSnapshotJson: EMPTY_DEF,
            refClosureJson: null,
          },
        },
      )
      expect(await rootTaskIdOf(db, grandchild.id)).toBe(root.id)
      __setActiveTaskForTesting(undefined)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })
})

async function rootTaskIdOf(
  db: ReturnType<typeof createInMemoryDb>,
  id: string,
): Promise<string | null> {
  const row = await db.select({ rootTaskId: tasks.rootTaskId }).from(tasks).where(eq(tasks.id, id))
  return row[0]?.rootTaskId ?? null
}
