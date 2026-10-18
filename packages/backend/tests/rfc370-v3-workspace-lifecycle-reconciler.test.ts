// RFC-370 §9.2 V3 — the hosted parent lifecycle reconciler.
//
// Why these tests exist: a running CrewStation parent holds a Pod and quota,
// and the platform's migration barrier requires parents to be paused. The
// previous implementation never paused a parent once its AW task left the
// running state. These tests lock the pause decision (every "in use" fact
// keeps a parent running, only platform-`running` parents are paused, with a
// deterministic per-generation request key), the shared-owner idle period,
// the re-check right before the effect, tolerance of lifecycle races, the
// completion of lost close receipts, and per-row failure isolation.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { hostedTaskWorkspaces } from '@/db/schema'
import {
  createHostedWorkspaceLifecycle,
  hostedWorkspaceLifecycleOwner,
  HOSTED_SHARED_VOLUME_IDLE_MS,
  HOSTED_TASK_VOLUME_GRACE_MS,
} from '@/modules/source-control/infrastructure/crewstation/workspaceLifecycle'
import { hostedLifecycleRequestKey } from '@/modules/source-control/infrastructure/crewstation/taskWorkspace'
import { hostedWorkspaceOwnerKind } from '@/modules/source-control/infrastructure/crewstation/workspaceOwnership'
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

describeEachProvider('RFC-370 V3 hosted parent lifecycle reconciler', (harness) => {
  const lease = { epoch: 1, leaseId: 'lease', instanceId: 'instance' }
  const NOW = 10_000_000

  const setup = async () => {
    const control = createDatabaseHostedExecutionControl({ db: harness.db })
    for (const phase of ['preparing', 'active'] as const)
      await control.write({
        ...lease,
        owner: lease.instanceId,
        phase,
        expiresAt: Date.now() + 60_000,
      })
    const tasks = new Map<string, BusinessTask>()
    const pauses: { taskId: string; request: Mutation }[] = []
    const reads: string[] = []
    let pauseError: unknown = null
    let readError: { taskId: string; error: unknown } | null = null
    const api = {
      getTask: async (id: string) => {
        reads.push(id)
        if (readError?.taskId === id) throw readError.error
        const task = tasks.get(id)
        if (task === undefined) throw new Error(`unknown parent ${id}`)
        return task
      },
      pauseTask: async (id: string, request: Mutation) => {
        if (pauseError !== null) throw pauseError
        pauses.push({ taskId: id, request })
        tasks.set(id, { ...tasks.get(id)!, state: 'pausing' })
      },
      createTask: unused,
      closeTask: unused,
      resumeTask: unused,
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
    } satisfies CrewStationBusinessExecution
    const register = async (
      owner: string,
      options: {
        readonly state?: 'creating' | 'ready' | 'closing' | 'closed'
        readonly updatedAt?: number
        readonly platform?: Partial<BusinessTask>
      } = {},
    ) => {
      const businessTaskId = `cs-${owner}`
      await harness.db.insert(hostedTaskWorkspaces).values({
        taskId: owner,
        requestKey: `aw-task:installation:${owner}`,
        businessTaskId,
        state: options.state ?? 'ready',
        createdAt: 0,
        updatedAt: options.updatedAt ?? 0,
      })
      tasks.set(businessTaskId, {
        id: businessTaskId,
        state: 'running',
        resourceState: 'ready',
        generation: 5,
        ...options.platform,
      })
      return businessTaskId
    }
    const active = new Set<string>()
    const held = new Set<string>()
    const unsettled = new Set<string>()
    const closed: string[] = []
    const superseded = new Set<string>()
    let closeResult = true
    let activityCalls = 0
    let onActivity: (() => void | Promise<void>) | null = null
    let now = NOW
    const lifecycle = createHostedWorkspaceLifecycle({
      db: harness.db,
      api,
      fence: { current: () => lease, assertHeld: (tx, value) => control.assertHeld(tx, value) },
      workspaces: {
        close: async (taskId) => {
          closed.push(taskId)
          return closeResult
        },
        superseded: async (taskId) => superseded.has(taskId),
      },
      commands: { hasUnsettledCommands: async (id) => unsettled.has(id) },
      activity: {
        activeVolumeOwners: async () => {
          activityCalls++
          await onActivity?.()
          return new Set(active)
        },
      },
      held: (owner) => held.has(owner),
      now: () => now,
    })
    const row = async (owner: string) =>
      (
        await harness.db
          .select()
          .from(hostedTaskWorkspaces)
          .where(eq(hostedTaskWorkspaces.taskId, owner))
      )[0]
    return {
      lifecycle,
      register,
      tasks,
      pauses,
      reads,
      active,
      held,
      unsettled,
      closed,
      superseded,
      row,
      setNow: (value: number) => {
        now = value
      },
      activityCalls: () => activityCalls,
      failPause: (error: unknown) => {
        pauseError = error
      },
      failRead: (taskId: string, error: unknown) => {
        readError = { taskId, error }
      },
      duringActivity: (hook: (() => void | Promise<void>) | null) => {
        onActivity = hook
      },
      closeResult: (value: boolean) => {
        closeResult = value
      },
    }
  }
  const pass = (f: Awaited<ReturnType<typeof setup>>) =>
    f.lifecycle.pass(new AbortController().signal)

  test('an idle AW task parent is paused with a per-generation key and the current fence', async () => {
    const f = await setup()
    const id = await f.register('01TASK')
    expect(await pass(f)).toEqual({ paused: ['01TASK'], closed: [], failed: [] })
    expect(f.pauses).toEqual([
      {
        taskId: id,
        request: {
          requestKey: hostedLifecycleRequestKey('aw-task:installation:01TASK', 'pause', 5),
          fence: lease,
          expectedGeneration: 5,
        },
      },
    ])
    // A parent the platform no longer runs is never paused again.
    expect(await pass(f)).toEqual({ paused: [], closed: [], failed: [] })
    expect(f.pauses).toHaveLength(1)
  })

  test('every in-use fact keeps a parent running', async () => {
    const f = await setup()
    await f.register('01ACTIVE')
    await f.register('01HELD')
    await f.register('01COMMAND')
    await f.register('01RECENT', { updatedAt: NOW - HOSTED_TASK_VOLUME_GRACE_MS + 1 })
    f.active.add('01ACTIVE')
    f.held.add('01HELD')
    f.unsettled.add('cs-01COMMAND')
    expect(await pass(f)).toEqual({ paused: [], closed: [], failed: [] })
    expect(f.pauses).toEqual([])
    // Cheap facts are decided before any platform read.
    expect(f.reads).toEqual([])
  })

  test('only platform-running parents are paused', async () => {
    const f = await setup()
    for (const state of ['paused', 'pausing', 'creating', 'admitting', 'failed'])
      await f.register(`01${state.toUpperCase()}`, { platform: { state } })
    await f.register('01CREATINGROW', { state: 'creating' })
    expect(await pass(f)).toEqual({ paused: ['01CREATINGROW'], closed: [], failed: [] })
  })

  test('shared owners wait for the idle period; AW tasks only for the short grace', async () => {
    const f = await setup()
    expect(hostedWorkspaceOwnerKind('01TASK')).toBe('task')
    expect(hostedWorkspaceOwnerKind('development:shared')).toBe('shared')
    for (const owner of ['system:intent', 'system:shared', 'mcp-test:01SESSION'])
      expect(hostedWorkspaceOwnerKind(owner)).toBe('scratch')
    await f.register('development:shared', { updatedAt: NOW - HOSTED_TASK_VOLUME_GRACE_MS - 1 })
    await f.register('system:shared', { updatedAt: NOW - HOSTED_TASK_VOLUME_GRACE_MS - 1 })
    await f.register('01TASK', { updatedAt: NOW - HOSTED_TASK_VOLUME_GRACE_MS - 1 })
    expect((await pass(f)).paused).toEqual(['01TASK'])
    f.setNow(NOW + HOSTED_SHARED_VOLUME_IDLE_MS)
    expect([...(await pass(f)).paused].sort()).toEqual(['development:shared', 'system:shared'])
  })

  // RFC-370 hosted acceptance (2026-10-17): a parent keeps the task image it was
  // created with, and the shared system scratch parent created under an earlier
  // release kept failing every memory distillation of a later one. A scratch
  // parent of another release is closed once idle, never paused and resumed.
  test('a scratch parent of another release is closed once idle, running or paused', async () => {
    const f = await setup()
    const idle = { updatedAt: NOW - HOSTED_SHARED_VOLUME_IDLE_MS - 1 }
    await f.register('system:shared', idle)
    await f.register('system:intent', { ...idle, platform: { state: 'paused' } })
    await f.register('system:busy', idle)
    await f.register('system:recent', { updatedAt: NOW - 1 })
    await f.register('system:current', idle)
    await f.register('development:shared', idle)
    for (const owner of ['system:shared', 'system:intent', 'system:busy', 'system:recent'])
      f.superseded.add(owner)
    f.active.add('system:busy')
    const result = await pass(f)
    expect([...result.closed].sort()).toEqual(['system:intent', 'system:shared'])
    expect(f.closed.sort()).toEqual(['system:intent', 'system:shared'])
    // A current scratch parent and a durable shared owner are only paused; one
    // in use or used recently is left alone.
    expect([...result.paused].sort()).toEqual(['development:shared', 'system:current'])
    expect(result.failed).toEqual([])
  })

  test('a use that starts during the pass is re-checked right before the pause', async () => {
    const f = await setup()
    await f.register('01TASK')
    f.duringActivity(() => {
      // The second activity read happens right before the effect.
      if (f.activityCalls() === 2) f.active.add('01TASK')
    })
    expect(await pass(f)).toEqual({ paused: [], closed: [], failed: [] })
    expect(f.pauses).toEqual([])
    f.duringActivity(null)
    f.active.clear()
    // A ready mark refreshed while the pass runs (an ensure in between) also
    // cancels the pause: the row is re-read right before the effect.
    f.duringActivity(async () => {
      if (f.activityCalls() === 4)
        await harness.db
          .update(hostedTaskWorkspaces)
          .set({ updatedAt: NOW })
          .where(eq(hostedTaskWorkspaces.taskId, '01TASK'))
    })
    expect(await pass(f)).toEqual({ paused: [], closed: [], failed: [] })
    expect(f.pauses).toEqual([])
    expect(f.activityCalls()).toBe(4)
  })

  test('a lifecycle race is tolerated and other errors are isolated per parent', async () => {
    const f = await setup()
    await f.register('01RACE')
    f.failPause(new CrewStationApiError(409, 'conflict', 'active', { code: 'active_subtasks' }))
    expect(await pass(f)).toEqual({ paused: [], closed: [], failed: [] })
    f.failPause(new CrewStationApiError(429, 'quota_exceeded', 'retry', {}))
    expect(await pass(f)).toEqual({ paused: [], closed: [], failed: [] })
    f.failPause(null)
    await f.register('01BROKEN')
    f.failRead('cs-01BROKEN', new Error('platform down'))
    expect(await pass(f)).toEqual({ paused: ['01RACE'], closed: [], failed: ['01BROKEN'] })
    f.failPause(new CrewStationApiError(400, 'validation', 'bad', {}))
    f.tasks.set('cs-01RACE', { ...f.tasks.get('cs-01RACE')!, state: 'running' })
    expect([...(await pass(f)).failed].sort()).toEqual(['01BROKEN', '01RACE'])
  })

  test('lost close receipts converge and platform-released parents are recorded closed', async () => {
    const f = await setup()
    await f.register('01CLOSING', { state: 'closing' })
    await f.register('01RELEASED', { platform: { state: 'closed', resourceState: 'released' } })
    await f.register('01DONE', { state: 'closed' })
    const first = await pass(f)
    expect([...first.closed].sort()).toEqual(['01CLOSING', '01RELEASED'])
    expect(first.paused).toEqual([])
    expect(first.failed).toEqual([])
    expect(f.closed).toEqual(['01CLOSING'])
    expect((await f.row('01RELEASED'))!.state).toBe('closed')
    f.closeResult(false)
    expect((await pass(f)).closed).toEqual([])
    expect(f.closed).toEqual(['01CLOSING', '01CLOSING'])
  })

  test('an aborted pass stops before the next parent and the owner loop ends on abort', async () => {
    const f = await setup()
    await f.register('01A')
    await f.register('01B')
    const controller = new AbortController()
    f.duringActivity(() => controller.abort())
    expect(await f.lifecycle.pass(controller.signal)).toEqual({
      paused: [],
      closed: [],
      failed: [],
    })
    f.duringActivity(null)
    const loop = new AbortController()
    let passes = 0
    const owner = hostedWorkspaceLifecycleOwner(
      {
        async pass() {
          passes++
          if (passes === 3) loop.abort()
          if (passes === 2) throw new Error('transient')
          return { paused: [], closed: [], failed: [] }
        },
      },
      { intervalMs: 1 },
    )
    expect(owner.id).toBe('hosted-workspace-lifecycle')
    await owner.run(loop.signal)
    expect(passes).toBe(3)
  })
})
