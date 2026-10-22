// RFC-370 persistent parent (CS business task) lifecycle owned by Source
// Control. Why these tests exist:
//   - §9.2 V3: every use resumes a paused parent before touching its volume,
//     with a deterministic per-generation requestKey and the current fence;
//     registration reads (`find` / `list` / `probe`) never wake a volume.
//   - §9.2 V3: `close` asks CrewStation FIRST and records `closing` only after
//     the platform accepted; only closed + released records `closed`. The old
//     order (record closing, then call CS) hid a parent whose close was never
//     sent. The durable workspace retentions table was removed with V5.
//   - M1 (kept): a lost create receipt and concurrent preparations resolve to
//     one durable request key, and a late readiness answer cannot resurrect a
//     concurrently closing parent.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  createHostedTaskWorkspaces,
  HOSTED_NO_ARTIFACTS_REASON,
  hostedLifecycleRequestKey,
} from '@/modules/source-control/infrastructure/crewstation/taskWorkspace'
import { createDatabaseHostedExecutionControl } from '@/modules/system-operations/infrastructure/hostedExecutionControl'
import type {
  BusinessTask,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import { CrewStationApiError } from '@/platform/crewstation/platformApi'
import { describeEachProvider } from './helpers/eachProvider'

const unused = async (): Promise<never> => {
  throw new Error('unexpected platform operation')
}

type Mutation = Parameters<CrewStationBusinessExecution['pauseTask']>[1]

describeEachProvider('RFC-370 persistent workspace lifecycle', (harness) => {
  const lease = { epoch: 1, leaseId: 'lease', instanceId: 'instance' }
  const setup = async (options: { readonly sleep?: (ms: number) => Promise<void> } = {}) => {
    const control = createDatabaseHostedExecutionControl({ db: harness.db })
    for (const phase of ['preparing', 'active'] as const)
      await control.write({
        ...lease,
        owner: lease.instanceId,
        phase,
        expiresAt: Date.now() + 60_000,
      })
    const calls: Parameters<CrewStationBusinessExecution['createTask']>[0][] = []
    const resumes: Mutation[] = []
    const closes: Mutation[] = []
    const finalizes: Parameters<CrewStationBusinessExecution['finalizeTask']>[1][] = []
    let task: BusinessTask = {
      id: 'parent',
      state: 'running',
      resourceState: 'ready',
      generation: 1,
    }
    let createsLost = 0
    let resumeError: unknown = null
    let closeError: unknown = null
    let onClose: (() => Promise<void>) | null = null
    const reads: string[] = []
    const api: CrewStationBusinessExecution = {
      createTask: async (request) => {
        calls.push(request)
        if (createsLost-- > 0) throw new Error('create ACK lost')
        return task
      },
      getTask: async (id) => {
        reads.push(id)
        return task
      },
      closeTask: async (_id, request) => {
        await onClose?.()
        if (closeError !== null) throw closeError
        closes.push(request)
        task = { ...task, state: 'closing', generation: task.generation + 1 }
      },
      finalizeTask: async (_id, request) => {
        if (closeError !== null) throw closeError
        finalizes.push(request)
        task = { ...task, state: 'finalizing', generation: task.generation + 1 }
      },
      pauseTask: unused,
      resumeTask: async (_id, request) => {
        resumes.push(request)
        if (resumeError !== null) throw resumeError
        task = {
          ...task,
          state: 'creating',
          resourceState: 'creating',
          generation: task.generation + 1,
        }
      },
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
    const sleeps: number[] = []
    let clock = 1_000_000
    const reopen = () =>
      createHostedTaskWorkspaces({
        db: harness.db,
        api,
        installation: 'project/service',
        taskContractVersion: 'aw-task-v1',
        fence: { current: () => lease, assertHeld: (tx, value) => control.assertHeld(tx, value) },
        now: () => clock,
        sleep:
          options.sleep ??
          (async (ms) => {
            sleeps.push(ms)
            clock += ms
            // The platform finishes an accepted resume while we wait.
            if (task.state === 'creating')
              task = { ...task, state: 'running', resourceState: 'ready' }
            if (task.state === 'pausing')
              task = { ...task, state: 'paused', resourceState: 'released' }
          }),
      })
    const row = async () => {
      const { hostedTaskWorkspaces } = tablesOf(harness.db)
      return (
        await harness.db
          .select()
          .from(hostedTaskWorkspaces)
          .where(eq(hostedTaskWorkspaces.taskId, 'task'))
      )[0]
    }
    return {
      workspace: reopen(),
      reopen,
      calls,
      resumes,
      closes,
      finalizes,
      reads,
      sleeps,
      api,
      row,
      loseCreate: () => {
        createsLost = 1
      },
      setTask: (value: BusinessTask) => {
        task = value
      },
      task: () => task,
      failResume: (error: unknown) => {
        resumeError = error
      },
      failClose: (error: unknown) => {
        closeError = error
      },
      duringClose: (hook: () => Promise<void>) => {
        onClose = hook
      },
    }
  }

  test('create response loss and concurrent preparations keep one durable parent request key', async () => {
    const f = await setup()
    f.loseCreate()
    await expect(f.workspace.ensure('task')).rejects.toThrow('create ACK lost')
    expect(await f.workspace.find('task')).toBeNull()
    const prepared = await Promise.all([f.workspace.ensure('task'), f.workspace.ensure('task')])
    expect(prepared).toEqual([
      { taskId: 'task', businessTaskId: 'parent' },
      { taskId: 'task', businessTaskId: 'parent' },
    ])
    expect(new Set(f.calls.map((call) => call.requestKey)).size).toBe(1)
    expect(await f.workspace.list()).toHaveLength(1)
  })

  test('ensure resumes a paused parent with a per-generation key and waits until it is ready', async () => {
    const f = await setup()
    await f.workspace.ensure('task')
    const before = (await f.row())!.updatedAt
    f.setTask({ id: 'parent', state: 'paused', resourceState: 'released', generation: 4 })
    await Bun.sleep(2)
    expect(await f.workspace.ensure('task')).toEqual({ taskId: 'task', businessTaskId: 'parent' })
    const requestKey = (await f.row())!.requestKey
    expect(f.resumes).toEqual([
      {
        requestKey: hostedLifecycleRequestKey(requestKey, 'resume', 4),
        fence: lease,
        expectedGeneration: 4,
      },
    ])
    expect(f.task()).toMatchObject({ state: 'running', resourceState: 'ready', generation: 5 })
    // The ready write is the last-use mark the lifecycle reconciler honours.
    expect((await f.row())!.updatedAt).toBeGreaterThan(before)
    expect(f.calls).toHaveLength(1)
  })

  test('a pausing parent is first allowed to settle, then resumed', async () => {
    const f = await setup()
    await f.workspace.ensure('task')
    f.setTask({ id: 'parent', state: 'pausing', resourceState: 'ready', generation: 2 })
    await f.workspace.ensure('task')
    expect(f.resumes.map((resume) => resume.expectedGeneration)).toEqual([2])
    expect(f.sleeps.length).toBeGreaterThanOrEqual(2)
  })

  test('a concurrent lifecycle refusal is re-observed instead of failing the use', async () => {
    // The wait after the refused resume is where another caller's resume lands
    // (deterministic: no wall-clock race against the reconciler's deadline).
    const concurrent: { resumedElsewhere?: () => void } = {}
    let waits = 0
    const f = await setup({
      sleep: async () => {
        waits += 1
        concurrent.resumedElsewhere?.()
      },
    })
    await f.workspace.ensure('task')
    f.setTask({ id: 'parent', state: 'paused', resourceState: 'released', generation: 3 })
    f.failResume(new CrewStationApiError(409, 'conflict', 'stale', { code: 'stale_generation' }))
    concurrent.resumedElsewhere = () => {
      f.failResume(null)
      f.setTask({ id: 'parent', state: 'running', resourceState: 'ready', generation: 4 })
    }
    expect(await f.workspace.ensure('task')).toEqual({ taskId: 'task', businessTaskId: 'parent' })
    expect(waits).toBeGreaterThan(0)
  })

  test('a non-lifecycle resume rejection fails the use', async () => {
    const f = await setup()
    await f.workspace.ensure('task')
    f.setTask({ id: 'parent', state: 'paused', resourceState: 'released', generation: 1 })
    f.failResume(new CrewStationApiError(412, 'precondition', 'nope', { code: 'task_not_running' }))
    await expect(f.workspace.ensure('task')).rejects.toThrow('nope')
    f.failResume(null)
    f.setTask({ id: 'other', state: 'running', resourceState: 'ready', generation: 2 })
    await expect(f.workspace.ensure('task')).rejects.toThrow('receipt-mismatch')
  })

  test('a short platform observation outage of the resources is waited out, not reported', async () => {
    const outage: { recover?: () => void } = {}
    let waits = 0
    const f = await setup({
      sleep: async () => {
        waits += 1
        outage.recover?.()
      },
    })
    await f.workspace.ensure('task')
    f.setTask({ id: 'parent', state: 'running', resourceState: 'unknown', generation: 3 })
    outage.recover = () =>
      f.setTask({ id: 'parent', state: 'running', resourceState: 'ready', generation: 3 })
    expect(await f.workspace.ensure('task')).toEqual({ taskId: 'task', businessTaskId: 'parent' })
    expect(waits).toBeGreaterThan(0)
  })

  // §9.2 V4: an unusable container/volume fails the node with an explicit,
  // task-page-readable reason pointing at the platform's rebuild action.
  test('a failed or unobservable parent fails with a rebuild instruction', async () => {
    const f = await setup()
    await f.workspace.ensure('task')
    for (const task of [
      { state: 'failed', resourceState: 'failed', message: 'node lost' },
      { state: 'running', resourceState: 'failed', message: 'volume detached' },
      // Unobservable resources are waited out first (60 s), then reported.
      { state: 'running', resourceState: 'unknown', message: 'accepted_resource_missing' },
    ]) {
      f.setTask({ id: 'parent', generation: 3, ...task })
      const error = await f.workspace.ensure('task').then(
        () => null,
        (failure: unknown) => failure,
      )
      expect(error).toMatchObject({
        code: 'hosted-workspace-unavailable',
        status: 503,
        details: {
          businessTaskId: 'parent',
          state: task.state,
          resourceState: task.resourceState,
          platformMessage: task.message ?? null,
        },
      })
      expect((error as Error).message).toContain('The CrewStation task container is ')
      expect((error as Error).message).toContain(task.message ?? 'no platform message')
      expect((error as Error).message).toContain(
        "Rebuild the workspace from CrewStation's recovery page: the task's files are then available " +
          'again, and an unfinished task continues once it is resumed.',
      )
      // An open of the same registration fails identically.
      await expect(f.workspace.open('task')).rejects.toMatchObject({
        code: 'hosted-workspace-unavailable',
      })
    }
    expect(f.resumes).toEqual([])
    // Unknown resources are expected while the platform is still provisioning.
    f.setTask({ id: 'parent', state: 'creating', resourceState: 'unknown', generation: 3 })
    expect(await f.workspace.ensure('task')).toEqual({ taskId: 'task', businessTaskId: 'parent' })
    // A parent the platform closed is not rebuildable: it is reported closed.
    f.setTask({ id: 'parent', state: 'closed', resourceState: 'released', generation: 4 })
    await expect(f.workspace.ensure('task')).rejects.toThrow('hosted-workspace-closed: closed')
  })

  test('a parent that never becomes ready times out with its last observed state', async () => {
    let now = 0
    const f = await setup({
      sleep: async () => {
        now += 1
      },
    })
    await f.workspace.ensure('task')
    f.setTask({ id: 'parent', state: 'creating', resourceState: 'creating', generation: 1 })
    const slow = createHostedTaskWorkspaces({
      db: harness.db,
      api: f.api,
      installation: 'project/service',
      taskContractVersion: 'aw-task-v1',
      fence: {
        current: () => lease,
        assertHeld: async () => undefined,
      },
      readyTimeoutMs: 3,
      now: () => now,
      sleep: async () => {
        now += 1
      },
    })
    const error = await slow.ensure('task').then(
      () => null,
      (failure: unknown) => failure,
    )
    // Distinct from an unavailable parent: the platform is merely slow.
    expect(error).toMatchObject({
      code: 'hosted-workspace-provisioning-timeout',
      status: 504,
      details: { businessTaskId: 'parent', lastObserved: 'creating/creating' },
    })
    expect((error as Error).message).toContain('hosted-workspace-provisioning-timeout')
    expect((error as Error).message).not.toContain('Rebuild the workspace')
  })

  test('open resumes an allocated parent, never allocates, and registration reads never wake it', async () => {
    const f = await setup()
    expect(await f.workspace.open('task')).toBeNull()
    expect(f.calls).toHaveLength(0)
    await f.workspace.ensure('task')
    f.setTask({ id: 'parent', state: 'paused', resourceState: 'released', generation: 7 })
    expect(await f.workspace.find('task')).toEqual({ taskId: 'task', businessTaskId: 'parent' })
    expect(await f.workspace.list()).toEqual([{ taskId: 'task', businessTaskId: 'parent' }])
    expect(await f.workspace.probe('task')).toBe('dormant')
    expect(await f.workspace.listRunning()).toEqual([])
    expect(f.resumes).toEqual([])
    expect(await f.workspace.open('task')).toEqual({ taskId: 'task', businessTaskId: 'parent' })
    expect(f.resumes.map((resume) => resume.expectedGeneration)).toEqual([7])
    expect(await f.workspace.probe('task')).toBe('running')
    expect(await f.workspace.listRunning()).toEqual([{ taskId: 'task', businessTaskId: 'parent' }])
    expect(await f.workspace.probe('unknown')).toBe('absent')
    f.setTask({ id: 'parent', state: 'closed', resourceState: 'released', generation: 8 })
    expect(await f.workspace.probe('task')).toBe('gone')
    expect(f.calls).toHaveLength(1)
  })

  test('close asks CrewStation before recording closing and needs physical release to finish', async () => {
    const f = await setup()
    await f.workspace.ensure('task')
    const states: string[] = []
    f.duringClose(async () => {
      states.push((await f.row())!.state)
    })
    expect(await f.workspace.close('task')).toBe(false)
    // CS was asked while the registration still read `ready`.
    expect(states).toEqual(['ready'])
    expect((await f.row())!.state).toBe('closing')
    expect(f.closes).toEqual([
      {
        requestKey: hostedLifecycleRequestKey((await f.row())!.requestKey, 'close', 1),
        fence: lease,
        expectedGeneration: 1,
      },
    ])
    expect(await f.workspace.find('task')).toBeNull()
    expect(await f.workspace.open('task')).toBeNull()
    expect(await f.workspace.list()).toEqual([])
    await expect(f.workspace.ensure('task')).rejects.toThrow('hosted-workspace-closed')
    f.setTask({ id: 'parent', state: 'closed', resourceState: 'releasing', generation: 2 })
    expect(await f.workspace.close('task')).toBe(false)
    f.setTask({ id: 'parent', state: 'closed', resourceState: 'released', generation: 2 })
    expect(await f.workspace.close('task')).toBe(true)
    expect((await f.row())!.state).toBe('closed')
    expect(await f.workspace.close('task')).toBe(true)
    // A closing/closed parent is never asked to close twice.
    expect(f.closes).toHaveLength(1)
  })

  // RFC-370 hosted acceptance (2026-10-18): closing a `legacy` parent keeps
  // its persistent volume, so every deleted task leaked a PVC until the
  // project's volume quota failed new tasks (`pod-missing`). AW now creates
  // `archive-and-delete` parents and finalizes them, which deletes the volume.
  test('an archive-and-delete parent is finalized with no artifacts and never closed', async () => {
    const f = await setup()
    f.setTask({ ...f.task(), completionPolicy: 'archive-and-delete' })
    await f.workspace.ensure('task')
    expect(await f.workspace.close('task')).toBe(false)
    expect((await f.row())!.state).toBe('closing')
    expect(f.closes).toEqual([])
    expect(f.finalizes).toEqual([
      {
        requestKey: hostedLifecycleRequestKey((await f.row())!.requestKey, 'finalize', 1),
        fence: lease,
        expectedGeneration: 1,
        outcome: 'succeeded',
        archive: { noArtifactsReason: HOSTED_NO_ARTIFACTS_REASON },
      },
    ])
    // A finalization in progress is observed, never requested again.
    expect(await f.workspace.close('task')).toBe(false)
    expect(f.finalizes).toHaveLength(1)
    f.setTask({
      ...f.task(),
      state: 'closed',
      resourceState: 'released',
    })
    expect(await f.workspace.close('task')).toBe(true)
    expect((await f.row())!.state).toBe('closed')
  })

  test('a legacy parent created before the completion policy is still closed', async () => {
    const f = await setup()
    f.setTask({ ...f.task(), completionPolicy: 'legacy' })
    await f.workspace.ensure('task')
    expect(await f.workspace.close('task')).toBe(false)
    expect(f.finalizes).toEqual([])
    expect(f.closes).toHaveLength(1)
  })

  test('a refused finalization records nothing and is retried later', async () => {
    const f = await setup()
    f.setTask({ ...f.task(), completionPolicy: 'archive-and-delete' })
    await f.workspace.ensure('task')
    f.failClose(new CrewStationApiError(409, 'conflict', 'stale', { code: 'stale_generation' }))
    expect(await f.workspace.close('task')).toBe(false)
    expect((await f.row())!.state).toBe('ready')
    expect(f.finalizes).toEqual([])
  })

  test('a refused close records nothing and is retried later', async () => {
    const f = await setup()
    await f.workspace.ensure('task')
    f.failClose(new CrewStationApiError(409, 'conflict', 'active', { code: 'active_subtasks' }))
    expect(await f.workspace.close('task')).toBe(false)
    expect((await f.row())!.state).toBe('ready')
    expect(f.closes).toEqual([])
    f.failClose(new CrewStationApiError(500, 'internal', 'down', {}))
    await expect(f.workspace.close('task')).rejects.toThrow('down')
    expect((await f.row())!.state).toBe('ready')
    f.failClose(null)
    expect(await f.workspace.close('task')).toBe(false)
    expect((await f.row())!.state).toBe('closing')
  })

  test('closing an unacknowledged parent recovers its receipt by replaying the create intent', async () => {
    const f = await setup()
    f.loseCreate()
    await expect(f.workspace.ensure('task')).rejects.toThrow('create ACK lost')
    expect((await f.row())!.businessTaskId).toBeNull()
    expect(await f.workspace.close('task')).toBe(false)
    expect(f.calls.map((call) => call.requestKey)).toEqual([
      f.calls[0]!.requestKey,
      f.calls[0]!.requestKey,
    ])
    expect(await f.row()).toMatchObject({ businessTaskId: 'parent', state: 'closing' })
    expect(f.closes).toHaveLength(1)
    // Nothing allocated at all: closing is trivially complete.
    expect(await f.workspace.close('never-allocated')).toBe(true)
  })

  test('a delayed readiness response cannot resurrect a concurrently closing workspace', async () => {
    const f = await setup()
    await f.workspace.ensure('task')
    let release!: (task: BusinessTask) => void
    let observed!: () => void
    const started = new Promise<void>((resolve) => {
      observed = resolve
    })
    const ordinaryRead = f.api.getTask
    f.api.getTask = () => {
      f.api.getTask = ordinaryRead
      observed()
      return new Promise((resolve) => {
        release = resolve
      })
    }
    const preparing = f.workspace.ensure('task')
    await started
    expect(await f.workspace.close('task')).toBe(false)
    release({ id: 'parent', state: 'running', resourceState: 'ready', generation: 1 })
    await expect(preparing).rejects.toThrow('hosted-workspace-closed')
    expect(await f.workspace.find('task')).toBeNull()
  })

  test('lifecycle request keys stay within the platform limit', () => {
    expect(hostedLifecycleRequestKey('aw-task:abc:task', 'pause', 3)).toBe(
      'aw-task:abc:task:pause:3',
    )
    const long = hostedLifecycleRequestKey(`aw-task:abc:${'x'.repeat(200)}`, 'resume', 1)
    expect(long).toMatch(/^aw-task-op:[a-f0-9]{64}$/)
    expect(long.length).toBeLessThanOrEqual(128)
    expect(hostedLifecycleRequestKey(`aw-task:abc:${'x'.repeat(200)}`, 'resume', 2)).not.toBe(long)
  })
})
