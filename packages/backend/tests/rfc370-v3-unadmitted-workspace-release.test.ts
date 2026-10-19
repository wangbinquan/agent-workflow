// RFC-370 hosted acceptance (2026-10-19) — the parent of a launch that was
// never admitted is released.
//
// WHY THIS FILE EXISTS (regression intent): on a full single-node cluster,
// three launches on the independent RFC-042 service failed in their workspace
// preparation (`hosted-workspace-provisioning-timeout`). A launch prepares the
// workspace before the Task row exists, so each failure left a CrewStation
// parent behind — two failed with volumes waiting to bind, one still being
// admitted, which would later have started a container for a Task that never
// existed — and nothing ever closed them: the compensation only cleaned files
// (waking the parent again), and the lifecycle reconciler ignores registrations
// without a parent receipt. The compensation now abandons the registration:
// the close intent is durable, a close never waits for a quota slot, and a
// create the platform refused leaves nothing to release.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { hostedTaskWorkspaces } from '@/db/schema'
import {
  createHostedTaskWorkspaces,
  HostedTaskImageUnvalidatedError,
  HostedWorkspaceQuotaExhaustedError,
} from '@/modules/source-control/infrastructure/crewstation/taskWorkspace'
import { createHostedScratchWorkspaces } from '@/modules/source-control/infrastructure/crewstation/repositoryPreparation'
import { createDatabaseHostedExecutionControl } from '@/modules/system-operations/infrastructure/hostedExecutionControl'
import type {
  BusinessTask,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import { CrewStationApiError } from '@/platform/crewstation/platformApi'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { describeEachProvider } from './helpers/eachProvider'

const unused = async (): Promise<never> => {
  throw new Error('unexpected platform operation')
}
const quotaFull = () =>
  new CrewStationApiError(429, 'quota_exceeded', '并发任务额度不足，请使用同一 requestKey 重试', {
    code: 'quota_exceeded',
  })
const imageRefused = () =>
  new CrewStationApiError(412, 'precondition', '该镜像尚未通过所选用途与档位的验证', {
    code: 'image_usage_unvalidated',
    imageVersionId: 'version-1',
  })

describeEachProvider('RFC-370 the parent of a never-admitted launch is released', (harness) => {
  const lease = { epoch: 1, leaseId: 'lease', instanceId: 'instance' }
  const setup = async () => {
    const control = createDatabaseHostedExecutionControl({ db: harness.db })
    for (const phase of ['preparing', 'active'] as const)
      await control.write({
        ...lease,
        owner: lease.instanceId,
        phase,
        expiresAt: Date.now() + 60_000,
      })
    const parents = new Map<string, BusinessTask>()
    const creates: string[] = []
    const finalized: string[] = []
    let refusal: (() => Error) | null = null
    const api: CrewStationBusinessExecution = {
      createTask: async (request) => {
        creates.push(request.requestKey)
        if (refusal !== null) throw refusal()
        const id = `parent-${request.requestKey.slice(-6)}`
        if (!parents.has(id))
          parents.set(id, {
            id,
            state: 'running',
            resourceState: 'ready',
            generation: 1,
            completionPolicy: 'archive-and-delete',
          })
        return parents.get(id)!
      },
      getTask: async (id) => parents.get(id)!,
      finalizeTask: async (id) => {
        finalized.push(id)
        const parent = parents.get(id)!
        parents.set(id, {
          ...parent,
          state: 'finalizing',
          resourceState: 'releasing',
          generation: parent.generation + 1,
        })
      },
      closeTask: unused,
      resumeTask: unused,
      pauseTask: unused,
      listSubtasks: unused,
      createMaterial: unused,
      submitSubtask: unused,
      getSubtask: unused,
      cancelSubtask: unused,
      events: unused,
      streamEvents: () => {
        throw new Error('unexpected event stream')
      },
      readFile: unused,
      listFiles: unused,
    }
    let clock = 1_000_000
    const workspaces = createHostedTaskWorkspaces({
      db: harness.db,
      api,
      installation: 'project/service',
      taskContractVersion: 'aw-task-v1',
      fence: { current: () => lease, assertHeld: (tx, value) => control.assertHeld(tx, value) },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      readyTimeoutMs: 300_000,
    })
    const row = async (owner: string) =>
      (
        await harness.db
          .select()
          .from(hostedTaskWorkspaces)
          .where(eq(hostedTaskWorkspaces.taskId, owner))
      )[0]
    const release = (id: string) =>
      parents.set(id, { ...parents.get(id)!, state: 'closed', resourceState: 'released' })
    return {
      workspaces,
      parents,
      creates,
      finalized,
      row,
      release,
      refuse: (next: (() => Error) | null) => {
        refusal = next
      },
      elapsed: () => clock - 1_000_000,
    }
  }

  test('an abandoned parent is finalized and recorded closed once the platform released it', async () => {
    const f = await setup()
    const { businessTaskId } = await f.workspaces.ensure('01UNADMITTED')
    await f.workspaces.abandon('01UNADMITTED')
    expect(f.finalized).toEqual([businessTaskId])
    expect(await f.row('01UNADMITTED')).toMatchObject({ state: 'closing', businessTaskId })
    // The lifecycle reconciler completes it on a later pass.
    f.release(businessTaskId)
    expect(await f.workspaces.close('01UNADMITTED')).toBe(true)
    expect((await f.row('01UNADMITTED'))?.state).toBe('closed')
    expect(f.finalized).toEqual([businessTaskId])
  })

  test('a launch still waiting for a quota slot is abandoned without waiting and released once admitted', async () => {
    const f = await setup()
    f.refuse(quotaFull)
    await expect(f.workspaces.ensure('01QUEUED')).rejects.toBeInstanceOf(
      HostedWorkspaceQuotaExhaustedError,
    )
    const waited = f.elapsed()
    expect(await f.row('01QUEUED')).toMatchObject({ state: 'creating', businessTaskId: null })
    const replays = f.creates.length
    await f.workspaces.abandon('01QUEUED')
    // One replay of the same key, no waiting, nothing to finalize yet.
    expect(f.creates.length).toBe(replays + 1)
    expect(new Set(f.creates).size).toBe(1)
    expect(f.elapsed()).toBe(waited)
    expect(await f.row('01QUEUED')).toMatchObject({ state: 'closing', businessTaskId: null })
    expect(await f.workspaces.close('01QUEUED')).toBe(false)
    // The platform admits the request: the next close finalizes that parent.
    f.refuse(null)
    expect(await f.workspaces.close('01QUEUED')).toBe(false)
    const admitted = (await f.row('01QUEUED'))!.businessTaskId!
    expect(f.finalized).toEqual([admitted])
    f.release(admitted)
    expect(await f.workspaces.close('01QUEUED')).toBe(true)
    expect((await f.row('01QUEUED'))?.state).toBe('closed')
  })

  test('a create the platform refused leaves nothing to release', async () => {
    const f = await setup()
    f.refuse(imageRefused)
    await expect(f.workspaces.ensure('01REFUSED')).rejects.toBeInstanceOf(
      HostedTaskImageUnvalidatedError,
    )
    await f.workspaces.abandon('01REFUSED')
    expect(f.finalized).toEqual([])
    expect(await f.row('01REFUSED')).toMatchObject({ state: 'closed', businessTaskId: null })
  })

  test('only a Task owner is abandoned', async () => {
    const f = await setup()
    await f.workspaces.ensure('system:shared')
    await expect(f.workspaces.abandon('system:shared')).rejects.toThrow(
      'hosted-workspace-abandon-requires-task-owner',
    )
    expect(f.finalized).toEqual([])
  })

  test('the hosted scratch compensation never wakes the volume it releases', async () => {
    const helper = {
      call: async () => {
        throw new Error('the abandoned volume was used')
      },
    } as unknown as WorkspaceHelper
    const abandoned: string[] = []
    const scratch = createHostedScratchWorkspaces(helper, {
      abandon: async (taskId) => {
        abandoned.push(taskId)
      },
    })
    expect(
      await scratch.cleanup({ taskId: '01SCRATCH', assertCurrent: async () => undefined }),
    ).toEqual({ taskId: '01SCRATCH', complete: true, failures: [] })
    await scratch.releaseUnadmitted!('01SCRATCH')
    expect(abandoned).toEqual(['01SCRATCH'])
  })
})
