// RFC-370: resume and human-gate admission must await selected workspace reads.
// Promise truthiness must never admit an absent workspace or skip a missing repo.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { monotonicFactory } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, tasks, workflows } from '@/db/schema'
import { createFileWorkspacePresenceQueries } from '@/modules/source-control/composition'
import {
  assertWorktreePresentForResume,
  composeWorktreeResumePreflight,
} from '@/modules/task-execution/public/participants'
import { getTask, composeWorkgroupTaskRoomContinuationDriver } from '@/services/task'
import { describeEachProvider } from './helpers/eachProvider'
import { taskRecoveryOperations } from './helpers/taskRecoveryOperations'
import { createNoopSchedulerDriver } from './helpers/taskExecutionTestTopology'

const ulid = monotonicFactory()
function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}
async function seed(db: ProviderNeutralDatabase, preparing = false) {
  const workflowId = ulid(),
    taskId = ulid(),
    workspace = `workspace://${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'workspace presence',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'presence',
    workflowId,
    workflowSnapshot: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    repoPath: workspace,
    worktreePath: preparing ? '' : workspace,
    branch: `agent-workflow/${taskId}`,
    baseBranch: 'main',
    status: 'interrupted',
    inputs: '{}',
    startedAt: 1,
  })
  if (preparing)
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: '__repo_prep__',
      status: 'failed',
      startedAt: 1,
    })
  const task = await getTask(db, taskId)
  if (task === null) throw new Error('presence task missing')
  return { task, workspace }
}

describeEachProvider('RFC-370 selected workspace resume presence', (harness) => {
  for (const result of ['present', 'missing', 'unavailable'] as const) {
    test(`admission awaits the selected ${result} receipt`, async () => {
      const { task, workspace } = await seed(harness.db)
      const entered = barrier(),
        release = barrier()
      let settled = false
      const preflight = composeWorktreeResumePreflight({
        getTask: (id) => getTask(harness.db, id),
        taskRecoveryOperations: taskRecoveryOperations(harness.db),
        async worktreeExists(reference) {
          expect(reference).toBe(workspace)
          entered.release()
          await release.pending
          if (result === 'unavailable') throw new Error('workspace presence unavailable')
          return result === 'present'
        },
      })
      const admission = preflight(task.id, 'resume').then(
        () => {
          settled = true
          return null
        },
        (error: unknown) => {
          settled = true
          return error
        },
      )
      try {
        await entered.pending
        expect(settled).toBe(false)
        release.release()
        const value = await admission
        if (result === 'present') expect(value).toBeNull()
        else if (result === 'missing')
          expect(value).toMatchObject({ code: 'task-worktree-missing', status: 410 })
        else expect(value).toEqual(new Error('workspace presence unavailable'))
      } finally {
        release.release()
        await admission
      }
    })
  }

  test('repository preparation keeps the original conflict before any physical probe', async () => {
    const { task } = await seed(harness.db, true)
    await expect(
      assertWorktreePresentForResume(taskRecoveryOperations(harness.db), task, 'resume', () => {
        throw new Error('probe must not run')
      }),
    ).rejects.toMatchObject({ code: 'task-repo-prep-incomplete', status: 409 })
  })

  for (const anyPresent of [true, false]) {
    test(`multi-repo sequential probes retain the original any-present predicate (${anyPresent})`, async () => {
      const { task, workspace } = await seed(harness.db)
      const calls: string[] = [],
        entered = barrier(),
        release = barrier()
      const refs = [1, 2, 3].map((n) => `${workspace}/repo-${n}`)
      const multi = {
        ...task,
        repoCount: 3,
        repos: refs.map((worktreePath, repoIndex) => ({
          ...task.repos[0]!,
          repoIndex,
          worktreePath,
        })),
      }
      const admission = assertWorktreePresentForResume(
        taskRecoveryOperations(harness.db),
        multi,
        'resume',
        async (reference) => {
          calls.push(reference)
          if (reference === workspace) return true
          if (reference === refs[0]) {
            entered.release()
            await release.pending
            return false
          }
          return anyPresent
        },
      ).then(
        () => null,
        (error: unknown) => error,
      )
      try {
        await entered.pending
        expect(calls).toEqual([workspace, refs[0]!])
        release.release()
        const result = await admission
        if (anyPresent) {
          expect(result).toBeNull()
          expect(calls).toEqual([workspace, refs[0]!, refs[1]!])
        } else {
          expect(result).toMatchObject({ code: 'task-worktree-missing', status: 410 })
          expect(calls).toEqual([workspace, ...refs])
        }
      } finally {
        release.release()
        await admission
      }
    })
  }

  test('an absent task retains the original no-probe behavior', async () => {
    await expect(
      composeWorktreeResumePreflight({
        getTask: async () => null,
        taskRecoveryOperations: taskRecoveryOperations(harness.db),
        worktreeExists() {
          throw new Error('absent task must not probe')
        },
      })('missing', 'resume'),
    ).resolves.toBeUndefined()
  })

  test('the actual workgroup continuation binds its selected presence instance', async () => {
    const { task, workspace } = await seed(harness.db)
    const entered = barrier(),
      release = barrier()
    const workspacePresence = {
      expected: workspace,
      async exists(reference: string) {
        expect(reference).toBe(this.expected)
        entered.release()
        await release.pending
        return false
      },
    }
    const continuation = composeWorkgroupTaskRoomContinuationDriver({
      db: harness.db,
      configPath: '/unused-presence-config',
      schedulerDriver: createNoopSchedulerDriver(),
      taskRecoveryOperations: taskRecoveryOperations(harness.db),
      workspacePresence,
    })
    const admission = continuation.assertResumable(task.id, 'approve').then(
      () => null,
      (error: unknown) => error,
    )
    try {
      await entered.pending
      release.release()
      expect(await admission).toMatchObject({ code: 'task-worktree-missing', status: 410 })
    } finally {
      release.release()
      await admission
    }
  })
})

test('the independent local presence adapter retains real file existence behavior', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc370-presence-'))
  const local = createFileWorkspacePresenceQueries()
  try {
    expect(local.exists(root)).toBe(true)
    expect(local.exists(join(root, 'missing'))).toBe(false)
    expect(local.exists('')).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
