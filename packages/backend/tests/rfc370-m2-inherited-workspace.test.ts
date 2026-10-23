import { taskFixture, workflowFixture } from './helpers/model'
import { expect, test } from 'bun:test'
import { createCrewStationExecutionWorkspaces } from '@/modules/task-execution/composition/crewstationExecution'
import { createHostedIsolationWorkspaces } from '@/modules/source-control/infrastructure/crewstation/isolationWorkspace'
import { parseHostedWorkspaceReference } from '@/modules/source-control/infrastructure/crewstation/workspaceReference'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { IsolationWorkspace } from '@/modules/source-control/application/ports/isolationWorkspace'
import { describeEachProvider } from './helpers/eachProvider'
import { createHostedTaskDeletionContent } from '@/modules/task-execution/infrastructure/crewstation/taskDeletionContent'
import { cleanupDeletedTaskResources } from '@/modules/task-execution/infrastructure/taskDeleteRecovery'
import { createHostedWorkspaceMaintenance } from '@/modules/source-control/infrastructure/crewstation/workspaceMaintenance'
import type { WorkspaceTaskRecord } from '@/modules/source-control/application/ports/workspaceMaintenance'

describeEachProvider('RFC-370 inherited task volume ownership', (harness) => {
  test('call/fusion children resolve the persisted workspace owner while fresh and System tasks retain their identity', async () => {
    const snapshot = JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] })
    await workflowFixture(harness.db, {
      id: 'workflow',
      name: 'hosted',
      definition: snapshot,
      version: 1,
      schemaVersion: 2,
    })
    await taskFixture(
      harness.db,
      ['parent', 'child', 'fresh'].map((id) => ({
        id,
        name: id,
        workflowId: 'workflow',
        workflowSnapshot: snapshot,
        workflowVersion: 1,
        repoPath: '',
        worktreePath: id === 'fresh' ? '' : 'cs-workspace:parent/worktrees/parent',
        baseBranch: 'main',
        branch: 'main',
        inputs: '{}',
        status: 'pending' as const,
        startedAt: Date.now(),
      })),
    )
    const owners: string[] = []
    const binding = createCrewStationExecutionWorkspaces({
      db: harness.db,
      locate: parseHostedWorkspaceReference,
      workspaces: {
        find: async (taskId) => ({ businessTaskId: `parent-for-${taskId}` }),
        ensure: async (taskId) => {
          owners.push(taskId)
          return { businessTaskId: `parent-for-${taskId}` }
        },
      },
    })
    expect(await binding.ensure('child')).toEqual({ businessTaskId: 'parent-for-parent' })
    expect(await binding.workspaceTaskId('child')).toBe('parent-for-parent')
    expect(await binding.workspaceTaskId('parent')).toBe('parent-for-parent')
    expect(await binding.workspaceTaskId('system:intent')).toBe('parent-for-system:intent')
    await binding.ensure('parent')
    await binding.ensure('fresh')
    await binding.ensure('system:intent')
    expect(owners).toEqual(['parent', 'parent', 'fresh', 'system:intent'])
  })
})

test('workspace GC never reclaims a borrowed canonical scene and orphan isolation uses its observed physical owner', async () => {
  const calls: { taskId: string; method: string; args: readonly unknown[] }[] = []
  const closed: string[] = []
  const helper: WorkspaceHelper = {
    async call<T>(taskId: string, _operation: string, value: unknown): Promise<T> {
      const request = value as { method: string; args: unknown[] }
      calls.push({ taskId, ...request })
      return (request.method === 'listIsoTaskIds' ? ['child'] : true) as T
    },
  }
  // RFC-370 §9.2 V3: GC only removes directories inside a volume; the spy
  // proves it never allocates or closes a parent.
  const workspaces = {
    ensure: async () => {
      throw new Error('GC must not allocate a volume')
    },
    find: async (taskId: string) => ({ taskId, businessTaskId: `cs-${taskId}` }),
    probe: async () => 'running' as const,
    listRunning: async () => [{ taskId: 'parent', businessTaskId: 'cs-parent' }],
    close: async (taskId: string) => {
      closed.push(taskId)
      return true
    },
  }
  const maintenance = createHostedWorkspaceMaintenance({
    helper,
    isMaterializingTask: () => false,
    workspaces,
  })
  const child: WorkspaceTaskRecord = {
    id: 'child',
    status: 'done',
    repoPath: 'cs-workspace:parent/repos/repo',
    worktreePath: 'cs-workspace:parent/worktrees/parent',
    branch: 'main',
    baseBranch: 'main',
    spaceKind: 'remote',
    startedAt: 0,
    finishedAt: 1,
    workspacePruningAt: null,
    workspacePruneCause: null,
    workspacePrunedAt: null,
    lifecycleEventRevision: 1,
  }
  expect(await maintenance.removeWorkspace(child, [])).toBe(false)
  expect(calls).toEqual([])
  expect(closed).toEqual([])
  expect(await maintenance.removeIsoContainer(child, 'child')).toBe(true)
  expect(calls[0]).toMatchObject({ taskId: 'parent', method: 'removeIsoContainer' })
  expect(await maintenance.listIsoTaskIds()).toEqual(['child'])
  expect(await maintenance.removeIsoContainer(null, 'child')).toBe(true)
  expect(calls.at(-1)).toMatchObject({
    taskId: 'parent',
    method: 'removeIsoContainer',
    args: [null, 'child'],
  })
  await expect(maintenance.removeIsoContainer(null, 'unobserved')).rejects.toThrow(
    'owner-unobserved',
  )
  expect(closed).toEqual([])
})

test('child isolation keeps logical task identity while every filesystem reference stays on the parent volume', async () => {
  const requests: { taskId: string; value: unknown }[] = []
  const helper: WorkspaceHelper = {
    async call<T>(taskId: string, _operation: string, value: unknown): Promise<T> {
      requests.push({ taskId, value })
      return {
        taskId: 'child',
        key: 'node',
        dbNodeRunId: 'node',
        isolationRef: '/work/iso/child/node',
        workspaceRef: '/work/iso/child/node',
        passthrough: false,
        repositories: [],
      } as T
    },
  }
  const scope = await createHostedIsolationWorkspaces(helper).bind({
    taskId: 'child',
    storageRootRef: 'unused-native-root',
    repositories: [
      {
        repositoryRef: 'cs-workspace:parent/repos/repo',
        workspaceRef: 'cs-workspace:parent/worktrees/parent',
        mount: '',
        baseBranch: 'main',
      },
    ],
  })
  const workspace: IsolationWorkspace = await scope.create({ key: 'node', dbNodeRunId: 'node' })
  expect(workspace.taskId).toBe('child')
  expect(workspace.workspaceRef).toBe('cs-workspace:parent/iso/child/node')
  expect(requests[0]).toMatchObject({
    taskId: 'parent',
    value: {
      binding: {
        taskId: 'child',
        storageRootRef: '/work',
        repositories: [
          { repositoryRef: '/work/repos/repo', workspaceRef: '/work/worktrees/parent' },
        ],
      },
    },
  })
  expect(() =>
    createHostedIsolationWorkspaces(helper).bind({
      taskId: 'child',
      storageRootRef: 'unused',
      repositories: [
        {
          repositoryRef: 'cs-workspace:other/repos/repo',
          workspaceRef: 'cs-workspace:parent/worktrees/parent',
          mount: '',
          baseBranch: 'main',
        },
      ],
    }),
  ).toThrow('owner-mismatch')
})

test('deletion receipts retain inherited volume ownership and wait for physical release of owned volumes', async () => {
  const calls: { taskId: string; path: string }[] = []
  const closes: string[] = []
  let closing = false
  let released = false
  const helper: WorkspaceHelper = {
    async call<T>(taskId: string, operation: string, value: unknown): Promise<T> {
      expect(operation).toBe('delete-task-content')
      calls.push({ taskId, path: (value as { path: string }).path })
      return null as T
    },
  }
  const content = createHostedTaskDeletionContent({
    helper,
    locate: parseHostedWorkspaceReference,
    workspaces: {
      find: async () => (closing ? null : { businessTaskId: 'parent' }),
      close: async (id) => {
        closes.push(id)
        closing = true
        return released
      },
    },
  })
  const repositories = {
    removeWorktree: async () => undefined,
    deleteSnapshotRefs: async () => undefined,
  }
  // Frozen before deletion; replay has no dependency on the now-absent child row.
  const childPlan = {
    v: 2 as const,
    taskId: 'child',
    parentTaskId: 'parent',
    worktrees: [],
    directories: content.directories('child', 'cs-workspace:parent/worktrees/parent'),
  }
  expect(await cleanupDeletedTaskResources(childPlan, { content, repositories })).toBe('done')
  expect(closes).toEqual([])
  expect(calls).toEqual([
    { taskId: 'parent', path: '/work/runs/child' },
    { taskId: 'parent', path: '/work/logs/child' },
    { taskId: 'parent', path: '/work/scratch/child' },
  ])
  const rootPlan = {
    v: 2 as const,
    taskId: 'parent',
    parentTaskId: null,
    worktrees: [],
    directories: content.directories('parent', 'cs-workspace:parent/worktrees/parent'),
  }
  expect(await cleanupDeletedTaskResources(rootPlan, { content, repositories })).toBe('pending')
  expect(closes).toEqual(['parent'])
  released = true
  expect(await cleanupDeletedTaskResources(rootPlan, { content, repositories })).toBe('done')
  expect(closes.every((id) => id === 'parent')).toBe(true)
})
