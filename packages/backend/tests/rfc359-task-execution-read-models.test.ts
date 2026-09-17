// RFC-359 AC-1 / AC-6 —— 任务执行读模型**只有一份实现**，两个引擎跑同一组判据。
//
// 这个文件原名 `rfc349-task-execution-read-models-postgresql-adapter.test.ts`，
// 名字里的 "postgresql-adapter" 从来没有对应过一个 PostgreSQL 专属实现：
// 它导入的 `composePostgresqlTaskExecutionReadModels` 是
// `createTaskExecutionReadModels` 的**纯别名再导出**（`taskExecutionRuntime.ts` 里
// 一行 `export { X as composeSqliteX, X as composePostgresqlX }`，注释写着
// 「读模型只有一份实现；两个具名工厂只做绑定（bootstrap 收敛后一并删）」）。
//
// 按 plan §5fo 的判据——看用例 `new`/`compose` 的**是不是同一个符号**——它属于
// 「一份中立实现被喂了两种库」，不是 AC-1 的成对适配器，直接可迁。三个别名里
// `composeTaskExecutionReadModels` / `composeSqliteTaskExecutionReadModels` 本就零消费者，
// 随本次一并删除，`composePostgresqlTaskExecutionReadModels` 由本文件解绑后同删。
//
// 判据从「假池回放罐头行 + 断言发出的 SQL 文本」改成**真库真行**：
// 跑在真 PostgreSQL 上本来就证明了 schema 限定名与 join 写对了（写错当场报错），
// 而 `harness.recordStatements()` 还能把「几条语句 / 取回几行 / 有没有 ORDER BY」
// 这些**形状**判据一起锁住，两个引擎同一套。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { docVersions, nodeRuns, taskRepos, tasks, users, workflows } from '@/db/schema'
import { composeDynamicWorkflowPersistence } from '@/modules/task-execution/composition/dynamicWorkflowPersistence'
import { composeSqliteDynamicWorkflowValidationContext } from '@/modules/resource-catalog/composition/workflowOperations'
import { composeTaskExecutionRuntime } from '@/modules/task-execution/composition/taskExecutionRuntime'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/taskExecutionReadModels'
import { createSqliteTaskExecutionRuntimeParticipants } from '@/modules/task-execution/infrastructure/sqliteTaskExecutionRuntimeParticipants'
import { composeTestChildLaunchWorkgroup } from './helpers/taskExecutionTestTopology'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import { composeRuntimeRegistryOperations } from '@/platform/runtime-registry/composition'
import { createCollaborationRuntimeMechanics } from '@/modules/collaboration/infrastructure/collaborationRuntimeMechanics'
import { describeEachProvider } from './helpers/eachProvider'
import { sqliteMemoryInjectionQueries } from './helpers/memoryInjection'
import { composeTestWorkgroupTurns } from './helpers/workgroupTurns'
import {
  createTaskExecutionTestIdentity,
  createTestRepositoryPublicationTransport,
} from './helpers/taskExecutionTestTopology'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const REVIEW_SNAPSHOT = JSON.stringify({
  nodes: [
    { id: 'review-1', kind: 'review', title: 'Review', description: 'Inspect it' },
    { id: 'agent-1', kind: 'agent', title: 'Worker' },
  ],
})

describeEachProvider('RFC-359 任务执行读模型（双引擎，单一实现）', (h) => {
  async function seedTask(input: {
    readonly taskId: string
    readonly ownerUserId: string | null
    readonly workflowSnapshot: string
    readonly repos?: readonly { readonly dir: string; readonly path: string }[]
  }): Promise<void> {
    const db = h.db
    if (input.ownerUserId !== null) {
      await db.insert(users).values({
        id: input.ownerUserId,
        username: input.ownerUserId,
        displayName: input.ownerUserId,
        role: 'user',
        createdAt: 1,
        updatedAt: 1,
      })
    }
    await db
      .insert(workflows)
      .values({ id: `wf-${input.taskId}`, name: `wf-${input.taskId}`, definition: '{}' })
    await db.insert(tasks).values({
      id: input.taskId,
      name: input.taskId,
      workflowId: `wf-${input.taskId}`,
      workflowSnapshot: input.workflowSnapshot,
      repoPath: '/repo',
      worktreePath: `/worktrees/${input.taskId}`,
      baseBranch: 'main',
      branch: `agent-workflow/${input.taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: 1,
      ...(input.ownerUserId === null ? {} : { ownerUserId: input.ownerUserId }),
    })
    if (input.repos !== undefined && input.repos.length > 0) {
      await db.insert(taskRepos).values(
        input.repos.map((repo, index) => ({
          taskId: input.taskId,
          repoIndex: index,
          repoPath: `/src/${repo.dir}`,
          worktreeDirName: repo.dir,
          worktreePath: repo.path,
          baseBranch: 'main',
          branch: `agent-workflow/${input.taskId}`,
        })),
      )
    }
  }

  test('投影任务状态、多仓工作区、评审节点与评审闸门主体', async () => {
    await seedTask({
      taskId: 'task-1',
      ownerUserId: 'owner-1',
      workflowSnapshot: REVIEW_SNAPSHOT,
      // 故意乱序插入：`repo_index` 的 ORDER BY 是这条判据锁的东西之一。
      repos: [
        { dir: 'api', path: '/worktrees/task-1/api' },
        { dir: 'web', path: '/worktrees/task-1/web' },
      ],
    })
    await h.db.insert(nodeRuns).values({
      id: 'run-1',
      taskId: 'task-1',
      nodeId: 'review-1',
      status: 'awaiting_review',
      retryIndex: 0,
      startedAt: 1,
    })
    await h.db.insert(docVersions).values({
      id: 'doc-1',
      taskId: 'task-1',
      reviewNodeId: 'review-1',
      reviewNodeRunId: 'run-1',
      sourceNodeId: 'agent-1',
      sourcePortName: 'result',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'docs/doc-1.md',
      decision: 'pending',
      createdAt: 1,
    })

    const readModels = createTaskExecutionReadModels(h.db)
    const recording = h.recordStatements()
    try {
      await expect(readModels.statusProjection.find('task-1')).resolves.toEqual({
        taskId: 'task-1',
        status: 'running',
        errorSummary: null,
      })
      await expect(readModels.callGraphWorkspace.find('task-1')).resolves.toEqual({
        taskId: 'task-1',
        worktreePath: '/worktrees/task-1',
        repos: [
          { worktreeDirName: 'api', worktreePath: '/worktrees/task-1/api' },
          { worktreeDirName: 'web', worktreePath: '/worktrees/task-1/web' },
        ],
      })
      await expect(readModels.taskReviewNodes.find('task-1')).resolves.toEqual({
        taskId: 'task-1',
        taskOwnerUserId: 'owner-1',
        nodes: [{ reviewNodeId: 'review-1', title: 'Review', description: 'Inspect it' }],
      })
      await expect(readModels.reviewGateSubjects.find('run-1')).resolves.toEqual({
        nodeRunId: 'run-1',
        taskId: 'task-1',
        reviewNodeId: 'review-1',
        taskOwnerUserId: 'owner-1',
      })
    } finally {
      recording.stop()
    }

    // 形状判据（替代合一前那组「发出的 SQL 含 `"agent_workflow"."…"`」字符串断言）：
    // 四个投影 = 五条 SELECT（工作区那条要再取一次 task_repos），一条都不能多。
    const selects = recording.selects()
    expect(selects).toHaveLength(5)
    // 多仓那条必须按 repo_index 排序——否则多仓工作区的顺序在两个引擎上各凭天意。
    expect(selects[2]?.sql.toLowerCase()).toContain('order by')
    expect(selects[2]?.rows).toBe(2)
  })

  test('保留单根回退与损坏快照的行为', async () => {
    await seedTask({ taskId: 'task-2', ownerUserId: null, workflowSnapshot: '{not-json' })

    const readModels = createTaskExecutionReadModels(h.db)
    await expect(readModels.callGraphWorkspace.find('task-2')).resolves.toEqual({
      taskId: 'task-2',
      worktreePath: '/worktrees/task-2',
      repos: [{ worktreeDirName: '', worktreePath: '/worktrees/task-2' }],
    })
    await expect(readModels.taskReviewNodes.find('task-2')).resolves.toEqual({
      taskId: 'task-2',
      taskOwnerUserId: null,
      nodes: [],
    })
  })

  test('未知 id 一律 null，不抛', async () => {
    const readModels = createTaskExecutionReadModels(h.db)
    await expect(readModels.statusProjection.find('nope')).resolves.toBeNull()
    await expect(readModels.callGraphWorkspace.find('nope')).resolves.toBeNull()
    await expect(readModels.taskReviewNodes.find('nope')).resolves.toBeNull()
    await expect(readModels.reviewGateSubjects.find('nope')).resolves.toBeNull()
  })
})

describe('RFC-359 任务执行读模型的装配身份（SQLite 组合根）', () => {
  test('runtime 原样交回注入进来的 provider-中立读模型', () => {
    const sqlite = createInMemoryDb(MIGRATIONS)
    const readModels = createTaskExecutionReadModels(sqlite)
    const runtime = composeTaskExecutionRuntime({
      readModels,
      participants: createSqliteTaskExecutionRuntimeParticipants({
        db: sqlite,
        childLaunchWorkgroup: composeTestChildLaunchWorkgroup(sqlite),
        identityAccess: createTaskExecutionTestIdentity(sqlite).resources,
        memoryInjectionQueries: sqliteMemoryInjectionQueries(sqlite),
        collaborationRuntime: createCollaborationRuntimeMechanics(sqlite),
        persistence: createTaskExecutionPersistence(sqlite),
        runtimeSessionLeases: createRuntimeSessionLeaseOperations(sqlite),
        runtimeRegistry: composeRuntimeRegistryOperations(sqlite),
        workgroupTurns: composeTestWorkgroupTurns(sqlite),
        dynamicWorkflow: {
          persistence: composeDynamicWorkflowPersistence(sqlite),
          validationContext: composeSqliteDynamicWorkflowValidationContext(sqlite),
        },
        repositoryPublicationTransport: createTestRepositoryPublicationTransport(),
      }),
    })

    expect(runtime.readModels).toBe(readModels)
  })

  test('守护进程 bootstrap 显式选 SQLite，而不是靠 runtime 兜底', () => {
    const start = readFileSync(resolve(import.meta.dir, '../src/cli/start.ts'), 'utf8')
    expect(start).toContain('composeSqliteTaskExecutionProviderRuntime(db, {')
    expect(start).toContain('taskExecutionReadModels: taskExecutionRuntime.readModels,')
    expect(start).not.toContain('composeTaskExecutionRuntime({\n          readModels: undefined')
  })
})
