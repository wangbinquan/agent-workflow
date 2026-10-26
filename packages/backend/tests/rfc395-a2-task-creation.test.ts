// RFC-395 II-a A2: both providers write complete launch facts through the sole participant, without trigger assumptions.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { describeEachProvider } from './helpers/eachProvider'
import {
  taskFixture,
  nodeRunFixture,
  workflowFixture,
  readTaskFixtures,
  readTaskRepoFixtures,
  readNodeRunFixtures,
  readWorkflowFixtures,
} from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { createTaskCreationParticipantInTx } from '@/modules/task-execution/infrastructure/taskCreationParticipant'
import { writeTaskWorkspaceDirectoriesInTx } from '@/modules/task-execution/infrastructure/taskWorkspaceDirectoryParticipant'
import {
  TASK_DEFINITION_HOSTS,
  type TaskSubject,
} from '@/modules/task-execution/domain/taskSubject'
import type { TaskCreationInput } from '@/modules/task-execution/application/ports/taskCreation'
import { DrizzleTaskRollbackQueries } from '@/modules/task-execution/infrastructure/taskRollbackQueries'
import { loadNodeRollbackTarget } from '@/modules/task-execution/infrastructure/nodeRollbackPersistence'
import { planTaskCheckpointRollback } from '@/modules/task-execution/domain/taskCheckpointRollback'

function command(id: string, subject: TaskSubject): TaskCreationInput {
  return {
    subject,
    core: {
      id,
      name: 'A2 fixture',
      status: 'pending',
      startedAt: 10,
      ownerUserId: null,
      catalogVisibility: 'public',
      branchStartedAt: 10,
    },
    definition: {
      definitionOrigin: 'authored',
      workflowSnapshot: '{"nodes":[],"edges":[]}',
      workflowVersion: 3,
      inputs: '{}',
    },
    launch: { kind: 'root', launchOrigin: 'event' },
    launchContext: {},
    workspace: {
      repoPath: '',
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      baseCommit: null,
      spaceKind: 'remote',
    },
    repos: [],
    nodePaths: [],
  }
}

describeEachProvider('RFC-395 II-a A2 task creation and checkpoints', (harness) => {
  test('root participant supplies lineage/origin and minimal directories explicitly', async () => {
    const id = ulid()
    const workflowId = ulid()
    await workflowFixture(harness.db, { id: workflowId, name: 'authored', definition: '{}' })
    const input = command(id, { kind: 'workflow', sourceId: workflowId })
    const recording = harness.recordStatements()
    let receipt
    try {
      receipt = await harness.session.transaction((tx) =>
        createTaskCreationParticipantInTx(tx).create(input),
      )
    } finally {
      recording.stop()
    }
    const row = (await readTaskFixtures(harness.db, { id }))[0]!
    expect(row).toMatchObject({
      workflowId,
      rootTaskId: id,
      executionLineageId: id,
      launchOrigin: 'event',
      lineageSlotPathJson: receipt.lineageSlotPathJson,
      repoCount: 1,
      repos: [],
    })
    expect(row.lineageSlotPathJson).toBe(
      JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: 3 },
      ]),
    )
    const insert = recording.statements.find((entry) =>
      /insert into (?:(?:"?agent_workflow"?)\.)?"?tasks"?\s/i.test(entry.sql),
    )
    expect(insert).toBeDefined()
    expect(insert!.values).toContain(id)
    const launchInsert = recording.statements.find((entry) =>
      /insert into .*"task_launch_contexts"/i.test(entry.sql),
    )
    expect(launchInsert).toBeDefined()
    expect(launchInsert!.values).toContain(id)
    expect(launchInsert!.values).toContain(row.lineageSlotPathJson)
    expect(launchInsert!.values).toContain('event')
    const { taskSpaceNodes } = tablesOf(harness.db)
    // Target directory closure always records the root, including an unbound workspace.
    expect(
      await harness.db
        .select({ nodePath: taskSpaceNodes.nodePath })
        .from(taskSpaceNodes)
        .where(eq(taskSpaceNodes.taskId, id)),
    ).toEqual([{ nodePath: '' }])
  })

  test('child participant inherits origin and prefers the calling run lineage; preparation extends its root', async () => {
    const parentId = ulid(),
      runId = ulid(),
      childId = ulid(),
      workflowId = ulid()
    await workflowFixture(harness.db, { id: workflowId, name: 'parent', definition: '{}' })
    const parentPath = JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: parentId, workflowRevision: 2 },
    ])
    const callPath = JSON.stringify([
      ...JSON.parse(parentPath),
      { stableNodeKey: 'call', frozenOccurrenceKey: 'iteration:3', workflowRevision: 2 },
    ])
    await taskFixture(harness.db, {
      id: parentId,
      workflowId,
      workflowSnapshot: '{}',
      workflowVersion: 2,
      repoPath: '/repo',
      worktreePath: '/root',
      baseBranch: 'main',
      branch: 'parent',
      status: 'running',
      inputs: '{}',
      startedAt: 1,
      launchOrigin: 'webhook',
      rootTaskId: parentId,
      executionLineageId: parentId,
      lineageSlotPathJson: parentPath,
    })
    await nodeRunFixture(harness.db, {
      id: runId,
      taskId: parentId,
      nodeId: 'call',
      status: 'running',
      continuationSlotKey: 'slot:3',
      lineageSlotPathJson: callPath,
    })
    const parent = (await readTaskFixtures(harness.db, { id: parentId }))[0]!
    const input = command(childId, { kind: 'workflow', sourceId: workflowId })
    await harness.session.transaction(async (tx) => {
      await createTaskCreationParticipantInTx(tx).create({
        ...input,
        core: { ...input.core, parentTaskId: parentId, parentNodeRunId: runId, invocationDepth: 1 },
        launch: {
          kind: 'child',
          parent,
          parentNodeRunId: runId,
          continuationSlotKey: 'slot:3',
          parentRunLineageSlotPathJson: callPath,
        },
      })
      await writeTaskWorkspaceDirectoriesInTx(tx, childId, ['nested/svc'], ['empty/leaf'])
    })
    const child = (await readTaskFixtures(harness.db, { id: childId }))[0]!
    expect(child).toMatchObject({
      rootTaskId: parentId,
      executionLineageId: parentId,
      launchOrigin: 'webhook',
    })
    expect(JSON.parse(child.lineageSlotPathJson!)).toEqual([
      ...JSON.parse(callPath),
      { stableNodeKey: 'child-task', frozenOccurrenceKey: 'slot:3', workflowRevision: 3 },
    ])
    const { taskSpaceNodes } = tablesOf(harness.db)
    const nodes = await harness.db
      .select({ path: taskSpaceNodes.nodePath })
      .from(taskSpaceNodes)
      .where(eq(taskSpaceNodes.taskId, childId))
    // T-F6: persisted directories contain the root, mount ancestors and explicit leaf paths.
    expect(nodes.map((node) => node.path).sort()).toEqual([
      '',
      'empty',
      'empty/leaf',
      'nested',
      'nested/svc',
    ])
  })

  test('all four platform subjects create without a catalog host row', async () => {
    const subjects: TaskSubject[] = [
      { kind: 'agent', sourceId: null, sourceName: 'agent' },
      { kind: 'workgroup', sourceId: ulid() },
      { kind: 'digital-employee', sourceId: null },
      { kind: 'code-round', sourceId: ulid() },
    ]
    for (const subject of subjects) {
      const id = ulid()
      await harness.session.transaction((tx) =>
        createTaskCreationParticipantInTx(tx).create(command(id, subject)),
      )
      const row = (await readTaskFixtures(harness.db, { id }))[0]!
      expect(row.workflowId).toBe(
        TASK_DEFINITION_HOSTS[subject.kind as keyof typeof TASK_DEFINITION_HOSTS].id,
      )
    }
    for (const host of Object.values(TASK_DEFINITION_HOSTS))
      expect(await readWorkflowFixtures(harness.db, { id: host.id })).toEqual([])
  })

  test('caller-owned transaction rolls back task, mounts and directory tree together', async () => {
    const id = ulid()
    const input = command(id, { kind: 'digital-employee', sourceId: null })
    await expect(
      harness.session.transaction(async (tx) => {
        await createTaskCreationParticipantInTx(tx).create({
          ...input,
          repos: [
            {
              ordinal: 0,
              repoPath: '/repo',
              repoUrl: null,
              cachedRepoId: null,
              baseBranch: 'main',
              branch: 'task',
              workingBranch: null,
              baseCommit: null,
              worktreePath: '/root/svc',
              mountPath: 'svc',
              subdir: '',
              readonly: false,
              readonlyDirtyCount: null,
              hasSubmodules: null,
              submoduleInitOk: null,
              submoduleInitError: null,
            },
          ],
        })
        throw new Error('abort creation')
      }),
    ).rejects.toThrow('abort creation')
    expect(await readTaskFixtures(harness.db, { id })).toEqual([])
    expect(await readTaskRepoFixtures(harness.db, { taskId: id })).toEqual([])
    const { taskSpaceNodes } = tablesOf(harness.db)
    expect(
      await harness.db
        .select({ path: taskSpaceNodes.nodePath })
        .from(taskSpaceNodes)
        .where(eq(taskSpaceNodes.taskId, id)),
    ).toEqual([])
  })

  for (const mountPaths of [[''], ['svc'], ['a', 'nested/b']])
    test(`persisted partial checkpoint round trip ${JSON.stringify(mountPaths)}`, async () => {
      const id = ulid(),
        runId = ulid(),
        workflowId = ulid()
      await workflowFixture(harness.db, { id: workflowId, name: 'checkpoint', definition: '{}' })
      await taskFixture(harness.db, {
        id,
        workflowId,
        workflowSnapshot: '{}',
        repoPath: '/repo',
        worktreePath: '/root',
        baseBranch: 'main',
        branch: 'task',
        status: 'running',
        inputs: '{}',
        startedAt: 1,
        repos: mountPaths.map((mountPath, repoIndex) => ({
          repoIndex,
          mountPath,
          repoPath: '/repo',
          worktreePath: `/root/${mountPath}`,
          baseBranch: 'main',
          branch: 'task',
        })),
      })
      const mountPath = mountPaths.at(-1)!
      const checkpoints = [
        {
          mountPath,
          preSnapshot: 'sha',
          isolationBase: '',
          nodeTree: 'tree',
          submodules: { poolDirs: {}, subBases: {} },
        },
      ]
      await nodeRunFixture(harness.db, {
        id: runId,
        taskId: id,
        nodeId: 'agent',
        status: 'done',
        checkpoints,
      })
      const run = (await readNodeRunFixtures(harness.db, { id: runId }))[0]!
      expect(run.checkpoints).toEqual(checkpoints)
      const queried = (await new DrizzleTaskRollbackQueries(harness.db).load(id))!
      const loaded = (await loadNodeRollbackTarget(harness.db, id))!
      expect(loaded.repos).toEqual([...queried.repositories])
      expect(
        planTaskCheckpointRollback(
          queried.repositories.map((repo) => ({
            mountPath: repo.mountPath,
            worktreePath: repo.worktreePath,
          })),
          run.checkpoints,
        ),
      ).toEqual([
        {
          mountPath,
          worktreePath: mountPath === '' ? '/root' : `/root/${mountPath}`,
          snapshot: 'sha',
        },
      ])
    })
})
