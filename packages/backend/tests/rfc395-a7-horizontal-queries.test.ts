// RFC-395 II-a A7 part 2：横向调用方改走 owner 后保留投影、空值、原字节、排序与事务可见性。
import { beforeEach, expect, test } from 'bun:test'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  createTaskDeletionQueries,
  createTaskDetailQueries,
  createTaskPreparationQueries,
  createNodeRunQueries,
  createNodeOutputQueries,
  createTaskTriggerQueries,
} from '@/modules/task-execution/public/queries'
import { getTask, loadTaskFailureCodes } from '@/services/task'
import { describeEachProvider } from './helpers/eachProvider'
import {
  taskFixture,
  workflowFixture,
  taskRepoFixture,
  nodeRunFixture,
  nodeRunOutputFixture,
  patchTaskFixture,
  type TaskFixtureSpec,
} from './helpers/model'

const definition = ' { "inputs": [], "nodes": [], "edges": [] } '

describeEachProvider('RFC-395 II-a A7 horizontal owner queries', (h) => {
  async function task(id: string, extra: Partial<TaskFixtureSpec> = {}) {
    await taskFixture(h.db, {
      id,
      workflowId: 'wf',
      workflowSnapshot: definition,
      repoPath: '/repo',
      worktreePath: '/work',
      baseBranch: 'main',
      branch: id,
      status: 'done',
      inputs: '{}',
      startedAt: 10,
      ...extra,
    })
  }
  beforeEach(async () => {
    await workflowFixture(h.db, { id: 'wf', name: 'Authored', definition, version: 3 })
  })

  test('Task detail retains legacy repository fallback, malformed payload fallback and subject revision', async () => {
    const query = createTaskDetailQueries(h.db)
    expect(await query.read('missing')).toBeNull()
    await task('old', {
      workflowSnapshot: '{broken',
      inputs: '{broken',
      workflowVersion: 2,
      workspacePruningAt: 22,
    })
    const detail = await query.read('old')
    expect(detail?.definitionOrigin).toBe('authored')
    expect(detail?.task).toMatchObject({
      id: 'old',
      workflowId: 'wf',
      workflowName: 'Authored',
      workflowVersion: 2,
      workflowSnapshot: null,
      inputs: {},
      repoPath: '/repo',
      workspaceState: 'pruning',
      repoCount: 1,
    })
    expect(detail?.task.repos).toHaveLength(1)
    expect(detail?.task.repos[0]).toMatchObject({
      mountPath: '',
      repoPath: '/repo',
      worktreePath: '/work',
    })
  })

  test('Task detail uses ordinal mounts, keeps authored geometry and sees caller transaction writes', async () => {
    await task('mounts')
    await taskRepoFixture(h.db, [
      {
        taskId: 'mounts',
        repoIndex: 1,
        repoPath: '/b',
        branch: 'b',
        worktreePath: '/work/b',
        mountPath: 'b',
      },
      {
        taskId: 'mounts',
        repoIndex: 0,
        repoPath: '/a',
        branch: 'a',
        worktreePath: '/work/a',
        mountPath: 'a',
      },
    ])
    const { taskSpaceNodes } = tablesOf(h.db)
    await h.db
      .insert(taskSpaceNodes)
      .values({ taskId: 'mounts', nodePath: 'empty', schemaVersion: 1 })
    const detail = await createTaskDetailQueries(h.db).read('mounts')
    expect(detail?.task.repos.map((r) => r.mountPath)).toEqual(['a', 'b'])
    expect(detail?.task.spaceNodes?.map((node) => node.path)).toContain('empty')
    expect((await getTask(h.db, 'mounts'))?.workflowSnapshot).toEqual(JSON.parse(definition))
    await expect(
      h.session.transaction(async (tx) => {
        await patchTaskFixture(tx, { id: 'mounts' }, { name: 'inside' })
        expect((await createTaskDetailQueries(tx).read('mounts'))?.task.name).toBe('inside')
        throw new Error('rollback-detail')
      }),
    ).rejects.toThrow('rollback-detail')
    expect((await createTaskDetailQueries(h.db).read('mounts'))?.task.name).toBe('task-mounts')
  })

  test('preparation context decodes requested source and preserves missing/null/status facts', async () => {
    const query = createTaskPreparationQueries(h.db)
    expect(await query.context('missing')).toBeUndefined()
    expect(await query.status('missing')).toBeUndefined()
    await task('prep', {
      status: 'pending',
      worktreePath: '',
      cachedRepoId: 'mirror',
      baseBranch: 'feature',
      gitUserName: 'Name',
      gitUserEmail: 'mail',
      workingBranch: 'target',
    })
    expect(await query.context('prep')).toMatchObject({
      id: 'prep',
      status: 'pending',
      worktreePath: '',
      gitUserName: 'Name',
      gitUserEmail: 'mail',
      workingBranch: 'target',
      requestedSource: { cachedRepoId: 'mirror', repoGroupId: null, requestedRef: 'feature' },
    })
    expect(await query.status('prep')).toEqual({ status: 'pending' })
    await expect(
      h.session.transaction(async (tx) => {
        await patchTaskFixture(tx, { id: 'prep' }, { status: 'interrupted' })
        expect(await createTaskPreparationQueries(tx).status('prep')).toEqual({
          status: 'interrupted',
        })
        throw new Error('rollback-status')
      }),
    ).rejects.toThrow('rollback-status')
    expect(await query.status('prep')).toEqual({ status: 'pending' })
  })

  test('frozen replay retains both error cases, ordinal order and explicit node versus ancestor fallback', async () => {
    const query = createTaskPreparationQueries(h.db)
    await task('replay')
    await expect(query.frozenLayout('replay')).rejects.toThrow('no frozen repo snapshot')
    await taskRepoFixture(h.db, {
      taskId: 'replay',
      repoIndex: 0,
      repoPath: '/a',
      branch: 'a',
      worktreePath: '/work/a',
      mountPath: 'dir/a',
    })
    await expect(query.frozenLayout('replay')).rejects.toThrow('no cached mirror id')
    await task('valid')
    await taskRepoFixture(h.db, [
      {
        taskId: 'valid',
        repoIndex: 1,
        repoPath: '/b',
        branch: 'b',
        worktreePath: '/work/b',
        mountPath: 'b',
        cachedRepoId: 'mirror-b',
        readonly: true,
      },
      {
        taskId: 'valid',
        repoIndex: 0,
        repoPath: '/a',
        branch: 'a',
        worktreePath: '/work/a',
        mountPath: 'dir/a',
        cachedRepoId: 'mirror-a',
        baseBranch: 'feature',
        subdir: 'src',
      },
    ])
    const layout = await query.frozenLayout('valid')
    expect(layout.repos.map((r) => r.cachedRepoId)).toEqual(['mirror-a', 'mirror-b'])
    expect(layout.repos[0]).toMatchObject({ ref: 'feature', subdir: 'src', viaGroups: [] })
    expect(layout.nodes.map((n) => n.path)).toEqual(['', 'b', 'dir', 'dir/a'])
    const { taskSpaceNodes } = tablesOf(h.db)
    await h.db.insert(taskSpaceNodes).values([
      { taskId: 'valid', nodePath: 'z/deep', schemaVersion: 1 },
      { taskId: 'valid', nodePath: 'empty', schemaVersion: 1 },
    ])
    expect((await query.frozenLayout('valid')).nodes).toEqual([
      { path: 'empty', origins: [] },
      { path: 'z/deep', origins: [] },
    ])
  })

  test('deletion reads retain empty results, complete workspace members and BFS descendant semantics', async () => {
    const query = createTaskDeletionQueries(h.db)
    expect(await query.read('missing')).toBeUndefined()
    expect(await query.status('missing')).toBeUndefined()
    expect(await query.workspaces([])).toEqual({ tasks: [], repositories: [] })
    expect(await query.nonTerminalDescendant('missing')).toBeNull()
    await task('parent')
    await task('child', { parentTaskId: 'parent', spaceKind: 'inherited' })
    await task('grandchild', { parentTaskId: 'child', status: 'running' })
    await taskRepoFixture(h.db, {
      taskId: 'parent',
      repoIndex: 0,
      repoPath: '/member',
      branch: 'main',
      worktreePath: '/work/member',
    })
    expect(await query.read('child')).toEqual({
      id: 'child',
      status: 'done',
      spaceKind: 'inherited',
      worktreePath: '/work',
      repoPath: '/repo',
      parentTaskId: 'parent',
      parentNodeRunId: null,
    })
    expect(await query.status('parent')).toEqual({ status: 'done' })
    const workspaces = await query.workspaces(['parent', 'child', 'missing'])
    expect(workspaces.tasks.map((t) => t.id).sort()).toEqual(['child', 'parent'])
    expect(workspaces.repositories).toEqual([
      { taskId: 'parent', repoPath: '/member', worktreePath: '/work/member' },
    ])
    expect(await query.nonTerminalDescendant('parent')).toEqual({
      id: 'grandchild',
      status: 'running',
    })
    await patchTaskFixture(h.db, { id: 'grandchild' }, { status: 'canceled' })
    expect(await query.nonTerminalDescendant('parent')).toBeNull()
  })

  test('resume projection keeps caller mounts, all attempts and the same unsorted identity order', async () => {
    await task('runs')
    await taskRepoFixture(h.db, {
      taskId: 'runs',
      repoIndex: 0,
      repoPath: '/a',
      branch: 'a',
      worktreePath: '/work/a',
      mountPath: 'nested',
    })
    await nodeRunFixture(h.db, [
      {
        id: 'z-first',
        taskId: 'runs',
        nodeId: 'node',
        status: 'failed',
        retryIndex: 2,
        checkpoints: [{ mountPath: 'nested', preSnapshot: 'snapshot' }],
      },
      { id: 'a-second', taskId: 'runs', nodeId: 'node', status: 'done', retryIndex: 0 },
    ])
    const query = createNodeRunQueries(h.db)
    expect(await query.listResumeRuns('missing', [''])).toEqual([])
    const runs = await query.listResumeRuns('runs', ['nested'])
    expect(runs.map((r) => r.id)).toEqual((await query.list({ taskId: 'runs' })).map((r) => r.id))
    expect(runs.find((r) => r.id === 'z-first')?.rollback).toMatchObject({
      id: 'z-first',
      checkpointScope: 'mounts',
      checkpoints: [{ mountPath: 'nested', preSnapshot: 'snapshot' }],
    })
    expect(
      (await query.listResumeRuns('runs', [''])).find((r) => r.id === 'z-first')?.rollback
        .checkpointScope,
    ).toBe('workspace')
    expect(runs.every((r) => !('preSnapshotReposJson' in r))).toBe(true)
  })

  test('lease projection includes terminal holders, deduplicates owners and ignores released/foreign leases', async () => {
    await task('leases')
    await task('other')
    const { runtimeSessionLeases } = tablesOf(h.db)
    await h.db.insert(runtimeSessionLeases).values([
      ...['one', 'two'].map((sessionId) => ({
        protocol: 'opencode' as const,
        sessionId,
        taskId: 'leases',
        nodeId: 'node',
        createdNodeRunId: 'run',
        leaseNodeRunId: 'run',
        leaseNonceDigest: 'digest',
        leasedAt: 1,
      })),
      {
        protocol: 'opencode',
        sessionId: 'released',
        taskId: 'leases',
        nodeId: 'node',
        createdNodeRunId: 'released',
      },
      {
        protocol: 'opencode',
        sessionId: 'foreign',
        taskId: 'other',
        nodeId: 'node',
        createdNodeRunId: 'foreign',
        leaseNodeRunId: 'foreign',
        leaseNonceDigest: 'digest',
        leasedAt: 1,
      },
    ])
    const query = createNodeRunQueries(h.db)
    expect(await query.heldSession('missing')).toBeUndefined()
    const held = await query.heldSession('run')
    expect(held).toBeDefined()
    expect(['one', 'two']).toContain(held!.sessionId)
    expect(await query.heldSessionRunIds('leases')).toEqual(['run'])
    expect(await query.heldSessionRunIds('missing')).toEqual([])
  })

  test('produced-port query includes inactive outputs and frozen trigger context preserves bytes', async () => {
    await task('outputs', { triggerContextJson: ' { "retained" : true } ' })
    await nodeRunFixture(h.db, { id: 'run', taskId: 'outputs', nodeId: 'node', status: 'done' })
    await nodeRunOutputFixture(h.db, [
      { nodeRunId: 'run', portName: 'live', content: '', active: true },
      { nodeRunId: 'run', portName: 'old', content: 'old', active: false },
    ])
    const outputs = createNodeOutputQueries(h.db)
    expect(await outputs.listProducedPorts([])).toEqual([])
    expect(
      (await outputs.listProducedPorts(['run', 'missing'])).map((o) => o.portName).sort(),
    ).toEqual(['live', 'old'])
    const trigger = createTaskTriggerQueries(h.db)
    expect(await trigger.frozenContext('outputs')).toBe(' { "retained" : true } ')
    expect(await trigger.frozenContext('missing')).toBeUndefined()
    await task('no-trigger')
    expect(await trigger.frozenContext('no-trigger')).toBeNull()
  })

  test('failure code selects the freshest top-level failed-node attempt through the owner query', async () => {
    await task('failed', { status: 'failed', failedNodeId: 'node' })
    await nodeRunFixture(h.db, [
      {
        id: 'older',
        taskId: 'failed',
        nodeId: 'node',
        status: 'failed',
        failureCode: 'snapshot-lost',
      },
      {
        id: 'newer',
        taskId: 'failed',
        nodeId: 'node',
        status: 'failed',
        failureCode: 'spawn-failed',
      },
      {
        id: 'child',
        taskId: 'failed',
        nodeId: 'node',
        parentNodeRunId: 'newer',
        status: 'failed',
        failureCode: 'snapshot-lost',
      },
    ])
    expect(
      await loadTaskFailureCodes(h.db, [{ id: 'failed', status: 'failed', failedNodeId: 'node' }]),
    ).toEqual(new Map([['failed', 'spawn-failed']]))
    expect((await getTask(h.db, 'failed'))?.failureCode).toBe('spawn-failed')
  })
})
