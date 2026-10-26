import { createTaskCreationParticipantInTx } from '@/modules/task-execution/infrastructure/taskCreationParticipant'
import {
  taskMountReadColumns,
  projectTaskMountReadRow,
  taskReadColumns,
} from '@/modules/task-execution/infrastructure/taskRepositorySql'
import { tablesOf } from '@/platform/persistence/sessionTables'
// One rollback target loader runs against both real provider databases. The
// no-context observer case covers construction only, with no workspace effect.
import {
  createNodeRollbackEffectObserver,
  loadNodeRollbackTarget,
} from '@/modules/task-execution/infrastructure/nodeRollbackPersistence'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { insertOne } from '@/platform/persistence/singleInsert'
import { expect, test } from 'bun:test'
import { asc, eq } from 'drizzle-orm'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const repositoryIndexOrder =
  /order by (?:"agent_workflow"\.)?"task_repository_mounts"\."ordinal" asc$/i

const taskId = 'w26-rollback-task'
const startedAt = 1_700_000_000_000
const originalInputs = '{ "value": "保留原字节", "items": [2, 1] }'
const originalSnapshot = '{ "version": 1, "nodes": [] }'

async function seedTask(harness: ProviderHarness) {
  await harness.session.transaction(async (tx) => {
    await createTaskCreationParticipantInTx(tx).create({
      subject: { kind: 'workflow', sourceId: 'w26-rollback-workflow' },
      core: {
        id: taskId,
        name: 'rollback fixture',
        status: 'pending',
        startedAt,
        branchStartedAt: startedAt,
        ownerUserId: null,
        catalogVisibility: 'public',
      },
      definition: {
        definitionOrigin: 'authored',
        workflowSnapshot: originalSnapshot,
        workflowVersion: 1,
        inputs: originalInputs,
      },
      launch: { kind: 'root', launchOrigin: 'api' },
      launchContext: {},
      workspace: {
        repoPath: '/fixture/source',
        worktreePath: '/fixture/worktrees/task',
        baseBranch: 'main',
        branch: 'task/w26-rollback',
        baseCommit: null,
        spaceKind: 'remote',
      },
      repos: [],
      nodePaths: [],
    })
    const { taskLaunchContexts, taskRepositoryMounts } = tablesOf(tx)
    // This suite deliberately models converted zero-mount history. New bound tasks
    // acquire a root mount automatically; remove it explicitly before this fixture's rows.
    await tx.delete(taskRepositoryMounts).where(eq(taskRepositoryMounts.taskId, taskId))
    await tx
      .update(taskLaunchContexts)
      .set({ lineageSlotPathJson: '[]' })
      .where(eq(taskLaunchContexts.taskId, taskId))
  })
}

function repositoryRow(ordinal: number) {
  return {
    taskId,
    repoKey: `${taskId}:mount:${ordinal}`,
    ordinal,
    repoPath: `/fixture/source/repo-${ordinal}`,
    baseBranch: 'main',
    branch: `task/w26-repo-${ordinal}`,
    branchState: 'branch' as const,
    mountPath: `repo-${ordinal}`,
  }
}

async function readStored(db: PersistenceDb) {
  const { tasks, taskRepositoryMounts: taskRepos } = tablesOf(db)
  const taskRows = await db.select(taskReadColumns(db)).from(tasks).orderBy(asc(tasks.id))
  const repositoryRows = await db
    .select(taskMountReadColumns(db))
    .from(taskRepos)
    .orderBy(asc(taskRepos.taskId), asc(taskRepos.ordinal))
    .then((rows) => rows.map(projectTaskMountReadRow))
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
    await seedTask(harness)
    const before = await readStored(harness.db)
    const recording = harness.recordStatements()
    try {
      const target = await loadNodeRollbackTarget(harness.db, taskId)
      expect(target?.db).toBe(harness.db)
      expect({ ...target, db: undefined }).toEqual({
        taskId,
        db: undefined,
        worktreePath: '/fixture/worktrees/task',
        repos: [{ worktreePath: '/fixture/worktrees/task', mountPath: '' }],
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
    await seedTask(harness)
    const { taskRepositoryMounts: taskRepos } = tablesOf(harness.db)
    await harness.db.insert(taskRepos).values([4, 1, 2].map(repositoryRow))
    const before = await readStored(harness.db)
    const recording = harness.recordStatements()
    try {
      const target = await loadNodeRollbackTarget(harness.db, taskId)
      expect(target?.db).toBe(harness.db)
      expect({ ...target, db: undefined }).toEqual({
        taskId,
        db: undefined,
        worktreePath: '/fixture/worktrees/task',
        repos: [1, 2, 4].map((index) => ({
          worktreePath: `/fixture/worktrees/task/repo-${index}`,
          mountPath: `repo-${index}`,
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
    await seedTask(harness)
    const { taskRepositoryMounts: taskRepos } = tablesOf(harness.db)
    await insertOne(harness.db, taskRepos, repositoryRow(1))
    const before = await readStored(harness.db)
    const rollbackError = new Error('w26 rollback fixture failure')
    const editedInputs = '{ "value": "事务内", "items": [1, 2] }'
    let receivedError: unknown
    try {
      await harness.session.transaction(async (tx) => {
        const { tasks, taskDefinitions, taskRepositoryMounts: taskRepos } = tablesOf(tx)
        await tx
          .update(tasks)
          .set({ workspaceRootRef: '/fixture/transaction/task' })
          .where(eq(tasks.id, taskId))
        await tx
          .update(taskDefinitions)
          .set({ inputs: editedInputs })
          .where(eq(taskDefinitions.taskId, taskId))
        await tx
          .update(taskRepos)
          .set({ mountPath: 'nested/repo-1' })
          .where(eq(taskRepos.repoKey, repositoryRow(1).repoKey))
        await insertOne(tx, taskRepos, repositoryRow(0))
        const target = await loadNodeRollbackTarget(tx, taskId)
        expect(target?.db).toBe(tx)
        expect({ ...target, db: undefined }).toEqual({
          taskId,
          db: undefined,
          worktreePath: '/fixture/transaction/task',
          repos: [
            { worktreePath: '/fixture/transaction/task/repo-0', mountPath: 'repo-0' },
            { worktreePath: '/fixture/transaction/task/nested/repo-1', mountPath: 'nested/repo-1' },
          ],
        })
        const inside = await readStored(tx)
        expect(inside.taskRows).toEqual(
          before.taskRows.map((row) => ({
            ...row,
            repoCount: 2,
            repoPath: '/fixture/source/repo-0',
            branch: 'task/w26-repo-0',
            workspaceRootRef: '/fixture/transaction/task',
            worktreePath: '/fixture/transaction/task',
            inputs: editedInputs,
          })),
        )
        expect(inside.repositoryRows).toHaveLength(2)
        expect(inside.repositoryRows.find((row) => row.repoIndex === 1)).toEqual({
          ...before.repositoryRows[0]!,
          worktreePath: '/fixture/transaction/task/nested/repo-1',
          mountPath: 'nested/repo-1',
          worktreeDirName: 'nested/repo-1',
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
    await seedTask(harness)
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

// Target-shaped qualification fixtures, adapted from the W26 recorder cases.
// These pure checks do not execute PostgreSQL or claim a new hosted trace.
const recordedRepositoryQueries = [
  'select "task_id", "repo_key", "ordinal" from "task_repository_mounts" where "task_repository_mounts"."task_id" = ? order by "task_repository_mounts"."ordinal" asc',
  'select "task_id", "repo_key", "ordinal" from "agent_workflow"."task_repository_mounts" where "agent_workflow"."task_repository_mounts"."task_id" = $1 order by "agent_workflow"."task_repository_mounts"."ordinal" asc',
]

test('repository index SQL lock accepts both recorded provider qualification forms', () => {
  for (const statement of recordedRepositoryQueries) {
    expect(statement).toMatch(repositoryIndexOrder)
  }
})

test('repository index SQL lock rejects another schema, table, column, or direction', () => {
  const otherOrders = [
    '"other_schema"."task_repository_mounts"."ordinal" asc',
    '"task_runs"."ordinal" asc',
    '"agent_workflow"."task_runs"."ordinal" asc',
    '"task_repository_mounts"."task_id" asc',
    '"agent_workflow"."task_repository_mounts"."task_id" asc',
    '"task_repository_mounts"."ordinal" desc',
    '"agent_workflow"."task_repository_mounts"."ordinal" desc',
  ]
  for (const statement of recordedRepositoryQueries) {
    const query = statement.slice(0, statement.lastIndexOf(' order by '))
    for (const order of otherOrders) {
      expect(`${query} order by ${order}`).not.toMatch(repositoryIndexOrder)
    }
  }
})
