// RFC-395 II-b package O3: real-engine compatibility for Task-owned workspace, usage and Doctor facts.
import { expect, test } from 'bun:test'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createTaskCodeWorkspaceQueries,
  createTaskResourceLimitFacts,
  createTaskStatusCounts,
  composeSystemOperationsTaskPorts,
} from '@/modules/task-execution/composition'
import { readTaskResourceUsage } from '@/modules/task-execution/public/queries'
import { taskCheckpointMountPaths } from '@/modules/task-execution/infrastructure/taskCheckpointPersistence'
import { describeEachProvider } from './helpers/eachProvider'
import { taskFixture, taskRepoFixture, nodeRunFixture, patchTaskFixture } from './helpers/model'
import { readStoredNodeRunRows } from './helpers/model/storedRows'

async function seedTask(db: PersistenceDb, id: string) {
  await taskFixture(db, {
    id,
    workflowId: 'o3-workflow',
    workflowSnapshot: '{}',
    inputs: '{}',
    repoPath: '/repo',
    worktreePath: '/work/' + id,
    baseBranch: 'main',
    branch: 'task/' + id,
    status: 'running',
    startedAt: 1,
    baseCommit: 'base',
    runningMs: 10000,
    runningSince: null,
  })
}

describeEachProvider('RFC-395 II-b O3 owner facts', (harness) => {
  test('workspace preserves the root fallback, missing rows and NULL-first timeline', async () => {
    const db = harness.db
    await seedTask(db, 'workspace')
    await nodeRunFixture(db, [
      {
        id: 'started',
        taskId: 'workspace',
        nodeId: 'n',
        status: 'done',
        startedAt: 10,
        checkpoints: [{ mountPath: '', preSnapshot: 'saved' }],
        wrapperProgressJson: ' { "x": 1 } ',
      },
      { id: 'pending', taskId: 'workspace', nodeId: 'pending', status: 'pending', startedAt: null },
    ])
    const queries = createTaskCodeWorkspaceQueries(db)
    expect(await queries.findTask('missing')).toBeNull()
    expect(await queries.findNodeRun('missing')).toBeNull()
    expect(await queries.listNodeRuns('missing')).toEqual([])
    expect((await queries.findTask('workspace'))?.repos).toEqual([
      { mountPath: '', worktreePath: '/work/workspace', baseCommit: 'base' },
    ])
    expect(await taskCheckpointMountPaths(db, 'workspace')).toEqual([''])
    const runs = await queries.listNodeRuns('workspace')
    expect(runs.map((run) => run.id)).toEqual(['pending', 'started'])
    expect(runs[1]?.checkpoints).toEqual([{ mountPath: '', preSnapshot: 'saved' }])
    expect(runs[1]?.wrapperProgressJson).toBe(' { "x": 1 } ')
    expect(runs).toHaveLength(2)
    expect(await queries.findNodeRun('started')).toEqual(runs[1]!)
  })

  test('explicit mounts keep ordinal order and per-mount checkpoint values', async () => {
    const db = harness.db
    await seedTask(db, 'mounts')
    await taskRepoFixture(db, [
      {
        taskId: 'mounts',
        repoIndex: 2,
        mountPath: 'z',
        repoPath: '/repo/z',
        branch: 'z',
        worktreePath: '/work/z',
        baseCommit: 'z-base',
      },
      {
        taskId: 'mounts',
        repoIndex: 0,
        mountPath: 'a',
        repoPath: '/repo/a',
        branch: 'a',
        worktreePath: '/work/a',
        baseCommit: null,
      },
    ])
    await nodeRunFixture(db, {
      id: 'mount-run',
      taskId: 'mounts',
      nodeId: 'n',
      status: 'done',
      checkpoints: [
        { mountPath: 'a', preSnapshot: '' },
        { mountPath: 'z', preSnapshot: 'z-saved' },
      ],
    })
    const queries = createTaskCodeWorkspaceQueries(db)
    expect(await taskCheckpointMountPaths(db, 'mounts')).toEqual(['a', 'z'])
    expect((await queries.findTask('mounts'))?.repos).toEqual([
      { mountPath: 'a', worktreePath: '/work/a', baseCommit: null },
      { mountPath: 'z', worktreePath: '/work/z', baseCommit: 'z-base' },
    ])
    expect((await queries.findNodeRun('mount-run'))?.checkpoints).toEqual([
      { mountPath: 'a', preSnapshot: '' },
      { mountPath: 'z', preSnapshot: 'z-saved' },
    ])
  })

  test('human-wait decoding retains malformed/NULL/future-clock accounting and stored bytes', async () => {
    const db = harness.db
    await seedTask(db, 'parent')
    await seedTask(db, 'child')
    await patchTaskFixture(db, { id: 'child' }, { status: 'awaiting_human' })
    const payloads = [
      'not-json',
      'null',
      ' {"callHumanWaitMs":1000,"callHumanWaitSince":9000} ',
      '{"callHumanWaitMs":-1,"callHumanWaitSince":30000}',
      null,
    ]
    for (const [index, wrapperProgressJson] of payloads.entries()) {
      await nodeRunFixture(db, {
        id: 'wait-' + index,
        taskId: 'parent',
        nodeId: 'call-' + index,
        status: 'done',
        childTaskId: 'child',
        wrapperProgressJson,
        tokTotal: index,
      })
    }
    const facts = createTaskResourceLimitFacts(db)
    expect(
      (await facts.callHumanWaits('parent'))
        .map((row) => ({ ...row }))
        .sort(
          (a, b) => a.accumulatedMs - b.accumulatedMs || (a.openSince ?? 0) - (b.openSince ?? 0),
        ),
    ).toEqual([
      { childTaskId: 'child', accumulatedMs: 0, openSince: null },
      { childTaskId: 'child', accumulatedMs: 0, openSince: null },
      { childTaskId: 'child', accumulatedMs: 0, openSince: null },
      { childTaskId: 'child', accumulatedMs: 0, openSince: 30000 },
      { childTaskId: 'child', accumulatedMs: 1000, openSince: 9000 },
    ])
    expect(await readTaskResourceUsage(facts, 'parent', 10000)).toEqual({
      effectiveRunningMs: 8000,
      totalTokens: 10,
    })
    expect(await readTaskResourceUsage(facts, 'missing', 10000)).toBeNull()
    expect(await facts.listTaskStatuses([])).toEqual([])
    expect((await readStoredNodeRunRows(db)).map((row) => row.wrapperProgressJson)).toEqual(
      payloads,
    )
  })

  test('Doctor keeps its native read handle and shares the Task status-count owner with health', async () => {
    const db = harness.db
    for (const status of [
      'interrupted',
      'failed',
      'awaiting_review',
      'awaiting_human',
      'running',
      'done',
    ] as const) {
      await seedTask(db, status)
      await patchTaskFixture(
        db,
        { id: status },
        { status, autoRecoverySuspended: status === 'failed' },
      )
    }
    const binding = harness.applicationBinding
    const source =
      binding.provider === 'sqlite'
        ? { provider: 'sqlite' as const, db: binding.db.$client }
        : { provider: 'postgresql' as const, pool: binding.runtime.providerPool() }
    expect(await composeSystemOperationsTaskPorts().countLifecycleStates(source)).toEqual({
      interrupted: 1,
      failed: 1,
      awaitingReview: 1,
      awaitingHuman: 1,
      quarantined: 1,
    })
    expect(await createTaskStatusCounts(db).countRunningTasks()).toBe(1)
  })
})
