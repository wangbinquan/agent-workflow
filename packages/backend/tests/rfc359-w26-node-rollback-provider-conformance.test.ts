// One rollback target loader runs against both real provider databases. The
// no-context observer case covers construction only, with no workspace effect.
import { expect, test } from 'bun:test'
import { asc, eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { taskRepos, tasks } from '@/db/schema'
import {
  createNodeRollbackEffectObserver,
  loadNodeRollbackTarget,
} from '@/modules/task-execution/infrastructure/nodeRollbackPersistence'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const repositoryIndexOrder = /order by (?:"agent_workflow"\.)?"task_repos"\."repo_index" asc$/i

const taskId = 'w26-rollback-task'
const startedAt = 1_700_000_000_000
const originalInputs = '{ "value": "保留原字节", "items": [2, 1] }'
const originalSnapshot = '{ "version": 1, "nodes": [] }'

async function seedTask(harness: ProviderHarness, repoCount: number) {
  await harness.db.insert(tasks).values({
    id: taskId,
    name: 'rollback fixture',
    workflowId: 'w26-rollback-workflow',
    workflowSnapshot: originalSnapshot,
    workflowVersion: 1,
    inputs: originalInputs,
    repoPath: '/fixture/source',
    worktreePath: '/fixture/worktrees/task',
    baseBranch: 'main',
    branch: 'task/w26-rollback',
    status: 'pending',
    repoCount,
    startedAt,
    branchStartedAt: startedAt,
    rootTaskId: taskId,
    executionLineageId: taskId,
    lineageSlotPathJson: '[]',
  })
}

function repositoryRow(repoIndex: number) {
  return {
    taskId,
    repoIndex,
    repoPath: `/fixture/source/repo-${repoIndex}`,
    baseBranch: 'main',
    branch: `task/w26-repo-${repoIndex}`,
    worktreePath: `/fixture/worktrees/repo-${repoIndex}`,
    worktreeDirName: `repo-${repoIndex}`,
    mountPath: `nested/repo-${repoIndex}`,
  }
}

async function readStored(db: ProviderNeutralDatabase) {
  const taskRows = await db.select().from(tasks).orderBy(asc(tasks.id))
  const repositoryRows = await db
    .select()
    .from(taskRepos)
    .orderBy(asc(taskRepos.taskId), asc(taskRepos.repoIndex))
  return { taskRows, repositoryRows }
}

describeEachProvider('RFC-359 W26 node rollback persistence', (harness) => {
  test('an absent task stops after the task read', async () => {
    const recording = harness.recordStatements()
    try {
      expect(await loadNodeRollbackTarget(harness.db, taskId)).toBeNull()
      expect(recording.selects()).toHaveLength(1)
      expect(recording.selects().map(({ values, rows }) => ({ values, rows }))).toEqual([
        { values: [taskId, 1], rows: 0 },
      ])
    } finally {
      recording.stop()
    }
  })

  test('a task without repository rows keeps its original single-repository fallback', async () => {
    await seedTask(harness, 1)
    const before = await readStored(harness.db)
    const recording = harness.recordStatements()
    try {
      const target = await loadNodeRollbackTarget(harness.db, taskId)
      expect(target?.db).toBe(harness.db)
      expect(target).toEqual({
        taskId,
        db: harness.db,
        repoCount: 1,
        worktreePath: '/fixture/worktrees/task',
        repos: [{ worktreePath: '/fixture/worktrees/task', worktreeDirName: '' }],
      })
      expect(recording.selects().map(({ values, rows }) => ({ values, rows }))).toEqual([
        { values: [taskId, 1], rows: 1 },
        { values: [taskId], rows: 0 },
      ])
    } finally {
      recording.stop()
    }
    expect(await readStored(harness.db)).toEqual(before)
    expect(before.taskRows[0]?.inputs).toBe(originalInputs)
    expect(before.taskRows[0]?.workflowSnapshot).toBe(originalSnapshot)
    expect(before.taskRows[0]?.lineageSlotPathJson).toBe('[]')
  })

  test('repository index order and stored task fields survive the target projection', async () => {
    await seedTask(harness, 7)
    await harness.db.insert(taskRepos).values([4, 1, 2].map(repositoryRow))
    const before = await readStored(harness.db)
    const recording = harness.recordStatements()
    try {
      const target = await loadNodeRollbackTarget(harness.db, taskId)
      expect(target?.db).toBe(harness.db)
      expect(target).toEqual({
        taskId,
        db: harness.db,
        repoCount: 7,
        worktreePath: '/fixture/worktrees/task',
        repos: [1, 2, 4].map((index) => ({
          worktreePath: `/fixture/worktrees/repo-${index}`,
          worktreeDirName: `repo-${index}`,
        })),
      })
      expect(recording.selects().map(({ values, rows }) => ({ values, rows }))).toEqual([
        { values: [taskId, 1], rows: 1 },
        { values: [taskId], rows: 3 },
      ])
      expect(recording.selects()[1]?.sql).toMatch(repositoryIndexOrder)
    } finally {
      recording.stop()
    }
    expect(await readStored(harness.db)).toEqual(before)
    expect(before.repositoryRows.map((row) => row.repoIndex)).toEqual([1, 2, 4])
  })

  test('the actual transaction handle sees edits and rolls both complete rows back on failure', async () => {
    await seedTask(harness, 1)
    await harness.db.insert(taskRepos).values(repositoryRow(1))
    const before = await readStored(harness.db)
    const rollbackError = new Error('w26 rollback fixture failure')
    const editedInputs = '{ "value": "事务内", "items": [1, 2] }'
    let receivedError: unknown
    try {
      await harness.session.transaction(async (tx) => {
        await tx
          .update(tasks)
          .set({ repoCount: 9, worktreePath: '/fixture/transaction/task', inputs: editedInputs })
          .where(eq(tasks.id, taskId))
        await tx
          .update(taskRepos)
          .set({ worktreePath: '/fixture/transaction/repo-1' })
          .where(eq(taskRepos.taskId, taskId))
        await tx.insert(taskRepos).values(repositoryRow(0))
        const target = await loadNodeRollbackTarget(tx, taskId)
        expect(target?.db).toBe(tx)
        expect(target).toEqual({
          taskId,
          db: tx,
          repoCount: 9,
          worktreePath: '/fixture/transaction/task',
          repos: [
            { worktreePath: '/fixture/worktrees/repo-0', worktreeDirName: 'repo-0' },
            { worktreePath: '/fixture/transaction/repo-1', worktreeDirName: 'repo-1' },
          ],
        })
        const inside = await readStored(tx)
        expect(inside.taskRows).toEqual(
          before.taskRows.map((row) => ({
            ...row,
            repoCount: 9,
            worktreePath: '/fixture/transaction/task',
            inputs: editedInputs,
          })),
        )
        expect(inside.repositoryRows).toHaveLength(2)
        expect(inside.repositoryRows.find((row) => row.repoIndex === 1)).toEqual({
          ...before.repositoryRows[0]!,
          worktreePath: '/fixture/transaction/repo-1',
        })
        throw rollbackError
      })
    } catch (error) {
      receivedError = error
    }
    expect(receivedError).toBe(rollbackError)
    const after = await readStored(harness.db)
    expect(after).toEqual(before)
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    expect(after.taskRows[0]?.inputs).toBe(originalInputs)
    expect(after.taskRows[0]?.workflowSnapshot).toBe(originalSnapshot)
  })

  test('observer construction without an execution context returns undefined without SQL', async () => {
    await seedTask(harness, 1)
    const before = await readStored(harness.db)
    const recording = harness.recordStatements()
    try {
      expect(
        createNodeRollbackEffectObserver({
          db: harness.db,
          taskId,
          nodeRunId: 'w26-rollback-run',
          request: { snapshots: ['original'], path: '/fixture/worktrees/task' },
          resourceKeys: ['workspace:/fixture/worktrees/task'],
        }),
      ).toBeUndefined()
      expect(recording.statements).toEqual([])
    } finally {
      recording.stop()
    }
    expect(await readStored(harness.db)).toEqual(before)
  })
})

// Original SQLite recorder output and the PostgreSQL SQL received by the W26
// hosted test (run 34275439627). These pure checks do not execute PostgreSQL.
const recordedRepositoryQueries = [
  'select "task_id", "repo_index", "repo_path", "repo_url", "cached_repo_id", "base_branch", "branch", "working_branch", "base_commit", "worktree_path", "worktree_dir_name", "mount_path", "subdir", "readonly", "readonly_dirty_count", "workspace_profile_version", "workspace_profile_digest", "has_submodules", "submodule_init_ok", "submodule_init_error", "schema_version" from "task_repos" where "task_repos"."task_id" = ? order by "task_repos"."repo_index" asc',
  'select "task_id", "repo_index", "repo_path", "repo_url", "cached_repo_id", "base_branch", "branch", "working_branch", "base_commit", "worktree_path", "worktree_dir_name", "mount_path", "subdir", "readonly", "readonly_dirty_count", "workspace_profile_version", "workspace_profile_digest", "has_submodules", "submodule_init_ok", "submodule_init_error", "schema_version" from "agent_workflow"."task_repos" where "agent_workflow"."task_repos"."task_id" = $1 order by "agent_workflow"."task_repos"."repo_index" asc',
]

test('repository index SQL lock accepts both recorded provider qualification forms', () => {
  for (const statement of recordedRepositoryQueries) {
    expect(statement).toMatch(repositoryIndexOrder)
  }
})

test('repository index SQL lock rejects another schema, table, column, or direction', () => {
  const otherOrders = [
    '"other_schema"."task_repos"."repo_index" asc',
    '"task_runs"."repo_index" asc',
    '"agent_workflow"."task_runs"."repo_index" asc',
    '"task_repos"."task_id" asc',
    '"agent_workflow"."task_repos"."task_id" asc',
    '"task_repos"."repo_index" desc',
    '"agent_workflow"."task_repos"."repo_index" desc',
  ]
  for (const statement of recordedRepositoryQueries) {
    const query = statement.slice(0, statement.lastIndexOf(' order by '))
    for (const order of otherOrders) {
      expect(`${query} order by ${order}`).not.toMatch(repositoryIndexOrder)
    }
  }
})
