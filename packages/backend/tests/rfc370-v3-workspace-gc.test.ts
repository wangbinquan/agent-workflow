// RFC-370 §9.2 V3 — hosted worktree GC scope.
//
// Why these tests exist: hosted worktree GC used to close the whole CS parent
// after removing a task's worktree, which also destroyed `/work/runs` and
// `/work/logs` (archives and logs lost once auto GC was on). GC must delete
// only directories inside the volume; the parent closes only when its owner is
// deleted. With parents paused while idle, GC sweeps and existence checks must
// also never wake a paused parent (one resume per volume per GC pass).
import { expect, test } from 'bun:test'
import { createHostedWorkspaceMaintenance } from '@/modules/source-control/infrastructure/crewstation/workspaceMaintenance'
import { createHostedTaskDeletionRepositories } from '@/modules/source-control/infrastructure/crewstation/taskDeletionRepositories'
import type { HostedWorkspaceProbe } from '@/modules/source-control/infrastructure/crewstation/taskWorkspace'
import type { WorkspaceTaskRecord } from '@/modules/source-control/application/ports/workspaceMaintenance'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'

function harness(probes: Record<string, HostedWorkspaceProbe> = {}) {
  const calls: { taskId: string; operation: string; value: unknown }[] = []
  const lifecycle: string[] = []
  const helper: WorkspaceHelper = {
    async call<T>(taskId: string, operation: string, value: unknown): Promise<T> {
      calls.push({ taskId, operation, value })
      const method = (value as { method?: string }).method
      if (method === 'listIsoTaskIds') return ['iso-task'] as T
      if (method === 'listScratchDirectories' || method === 'listWorktreeLeaves')
        return [{ taskId: 'leaf', path: '/work/scratch/leaf' }] as T
      if (method === 'runPartialCloneGc') return { scanned: 2, removed: 1 } as T
      return true as T
    },
  }
  const registered = (taskId: string) =>
    (probes[taskId] ?? 'running') === 'absent' ? null : { taskId, businessTaskId: `cs-${taskId}` }
  // Spies for the operations GC must never perform.
  const workspaces = {
    find: async (taskId: string) => registered(taskId),
    probe: async (taskId: string) => probes[taskId] ?? 'running',
    listRunning: async () =>
      Object.keys(probes)
        .filter((taskId) => probes[taskId] === 'running')
        .map((taskId) => ({ taskId, businessTaskId: `cs-${taskId}` })),
    ensure: async (taskId: string) => {
      lifecycle.push(`ensure:${taskId}`)
      return { taskId, businessTaskId: `cs-${taskId}` }
    },
    close: async (taskId: string) => {
      lifecycle.push(`close:${taskId}`)
      return true
    },
  }
  return {
    calls,
    lifecycle,
    maintenance: createHostedWorkspaceMaintenance({
      helper,
      workspaces,
      isMaterializingTask: () => false,
    }),
    repositories: createHostedTaskDeletionRepositories({ helper, workspaces }),
  }
}

const task = (
  id: string,
  worktree = `cs-workspace:${id}/worktrees/${id}`,
): WorkspaceTaskRecord => ({
  id,
  status: 'done',
  repoPath: `cs-workspace:${id}/repos/repo`,
  worktreePath: worktree,
  branch: 'aw/task',
  baseBranch: 'main',
  spaceKind: 'remote',
  startedAt: 0,
  finishedAt: 1,
  workspacePruningAt: 1,
  workspacePruneCause: 'gc',
  workspacePrunedAt: null,
  lifecycleEventRevision: 1,
})

test('worktree GC removes only the worktree inside the volume and never closes the parent', async () => {
  const f = harness({ owned: 'running' })
  expect(await f.maintenance.removeWorkspace(task('owned'), [])).toBe(true)
  expect(f.calls).toEqual([
    {
      taskId: 'owned',
      operation: 'workspace-maintenance',
      value: {
        method: 'removeWorkspace',
        args: [
          { ...task('owned'), repoPath: '/work/repos/repo', worktreePath: '/work/worktrees/owned' },
          [],
        ],
      },
    },
  ])
  expect(f.lifecycle).toEqual([])
})

test('a parent without a registration has nothing to remove and is not closed by GC', async () => {
  const f = harness({ gone: 'absent' })
  expect(await f.maintenance.removeWorkspace(task('gone'), [])).toBe(false)
  expect(await f.maintenance.removeIsoContainer(task('gone'), 'gone')).toBe(false)
  expect(f.calls).toEqual([])
  expect(f.lifecycle).toEqual([])
})

test('existence checks answer from the platform state without waking a dormant parent', async () => {
  const f = harness({ dormant: 'dormant', gone: 'gone', absent: 'absent', live: 'running' })
  expect(await f.maintenance.exists('')).toBe(false)
  expect(await f.maintenance.exists('cs-workspace:dormant/worktrees/dormant')).toBe(true)
  expect(await f.maintenance.exists('cs-workspace:gone/worktrees/gone')).toBe(false)
  expect(await f.maintenance.exists('cs-workspace:absent/worktrees/absent')).toBe(false)
  expect(f.calls).toEqual([])
  expect(await f.maintenance.exists('cs-workspace:live/worktrees/live')).toBe(true)
  expect(f.calls).toEqual([
    { taskId: 'live', operation: 'exists', value: { path: '/work/worktrees/live' } },
  ])
  expect(f.lifecycle).toEqual([])
})

test('orphan sweeps visit only running parents', async () => {
  const f = harness({ live: 'running', paused: 'dormant' })
  expect(await f.maintenance.listScratchDirectories()).toEqual([
    { taskId: 'leaf', path: 'cs-workspace:live/scratch/leaf' },
  ])
  expect(await f.maintenance.listWorktreeLeaves()).toEqual([
    { taskId: 'leaf', path: 'cs-workspace:live/scratch/leaf' },
  ])
  expect(await f.maintenance.listIsoTaskIds()).toEqual(['iso-task'])
  expect(await f.maintenance.runPartialCloneGc(1, 2)).toEqual({ scanned: 2, removed: 1 })
  expect(new Set(f.calls.map((call) => call.taskId))).toEqual(new Set(['live']))
  // The orphan isolation container is removed from the volume it was seen in.
  expect(await f.maintenance.removeIsoContainer(null, 'iso-task')).toBe(true)
  expect(f.calls.at(-1)).toMatchObject({
    taskId: 'live',
    value: { method: 'removeIsoContainer', args: [null, 'iso-task'] },
  })
  expect(f.lifecycle).toEqual([])
})

test('task deletion cleans repositories in a registered volume and never closes it', async () => {
  const f = harness({ owner: 'running', gone: 'absent' })
  await f.repositories.removeWorktree({
    repoPath: 'cs-workspace:owner/repos/repo',
    worktreePath: 'cs-workspace:owner/worktrees/child',
    force: true,
  })
  await f.repositories.deleteSnapshotRefs('cs-workspace:owner/repos/repo', 'child')
  expect(f.calls.map((call) => (call.value as { method: string }).method)).toEqual([
    'removeWorktree',
    'deleteSnapshotRefs',
  ])
  // A volume without a registered parent holds nothing left to clean.
  await f.repositories.removeWorktree({
    repoPath: 'cs-workspace:gone/repos/repo',
    worktreePath: 'cs-workspace:gone/worktrees/gone',
    force: true,
  })
  await f.repositories.deleteSnapshotRefs('cs-workspace:gone/repos/repo', 'gone')
  expect(f.calls).toHaveLength(2)
  await expect(
    f.repositories.removeWorktree({
      repoPath: 'cs-workspace:owner/repos/repo',
      worktreePath: 'cs-workspace:other/worktrees/child',
      force: true,
    }),
  ).rejects.toThrow('owner-mismatch')
  expect(f.lifecycle).toEqual([])
})
