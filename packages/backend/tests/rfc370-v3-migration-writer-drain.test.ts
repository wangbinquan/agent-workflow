// RFC-370 v3 V7 / CS RFC-027 — draining this installation's writers during a
// platform freeze.
//
// Why these tests exist: RFC-370 hosted acceptance (2026-10-19). A database
// restore of the independent service waited in `freezing` indefinitely. The
// platform's barrier only proves that the service's business environments are
// paused, and the frozen AW instance acknowledged the freeze but never stopped
// its running `system:shared` parent (its idle-parent reconciler runs only
// while it holds execution authority). These tests lock:
// - the instance whose acknowledgement the platform accepted drains its
//   writers, throttled, on later ticks too, and only then;
// - a drain pass cancels a running parent's active subtasks and pauses the
//   parent only once they have results, under the freeze's stop authority,
//   with keys derived from the freeze;
// - it leaves paused / closed / failed parents alone and writes nothing to the
//   (write-frozen) database.
import { expect, test } from 'bun:test'
import { hostedTaskWorkspaces } from '@/db/schema'
import { createCrewStationExecutionAuthority } from '@/modules/system-operations/infrastructure/crewstation/crewStationExecutionAuthority'
import type { HostedExecutionControlRecord } from '@/modules/system-operations/application/ports/hostedExecutionControl'
import { createHostedMigrationDrain } from '@/modules/source-control/infrastructure/crewstation/workspaceLifecycle'
import type {
  BusinessSubtask,
  BusinessTask,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import {
  CrewStationApiError,
  type CrewStationPlatformApi,
} from '@/platform/crewstation/platformApi'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await Bun.sleep(2)
  }
}

function frozenPlatform(options: { refusals?: number } = {}) {
  let refusals = options.refusals ?? 0
  const calls: string[] = []
  const platform: CrewStationPlatformApi = {
    async get<T>(path: string): Promise<T> {
      calls.push(`GET ${path}`)
      return {
        epoch: 7,
        phase: 'frozen',
        leaseOwner: null,
        leaseExpiresAt: null,
        migration: { operationId: 'database-restore-1' },
      } as T
    },
    async post<T>(path: string): Promise<T> {
      calls.push(`POST ${path}`)
      if (path.endsWith('/ready') && refusals > 0) {
        refusals -= 1
        throw new CrewStationApiError(403, 'forbidden', 'not the active release pod', {})
      }
      return {} as T
    },
    async *stream<T>(): AsyncIterable<T> {
      yield* []
      throw new Error('unexpected stream')
    },
  }
  const writes: HostedExecutionControlRecord[] = []
  return { platform, calls, writes }
}

function authorityOver(f: ReturnType<typeof frozenPlatform>, drainMs = 20) {
  return createCrewStationExecutionAuthority({
    platform: f.platform,
    instanceId: '01a0bf5d-8f4b-7100-8000-000000000001',
    tickMs: 5,
    drainMs,
    control: {
      read: async () => f.writes.at(-1) ?? null,
      async write(value) {
        f.writes.push(value)
      },
    },
    acceptedTaskContractVersions: ['aw-task-v1'],
    log: createLogger('rfc370-migration-drain-test'),
  })
}

test('the instance whose freeze acknowledgement was accepted drains its writers, throttled, on later ticks too', async () => {
  const f = frozenPlatform({ refusals: 2 })
  const authority = authorityOver(f)
  const drains: { operationId: string; epoch: number }[] = []
  let readyWhenFirstDrained = 0
  authority.drainMigrationWith(async (stop) => {
    if (drains.length === 0)
      readyWhenFirstDrained = f.calls.filter((call) => call.endsWith('/ready')).length
    drains.push(stop)
    return { remaining: 1 }
  })
  try {
    authority.start()
    await until(() => drains.length >= 3)
    // Two refused acknowledgements drained nothing; the accepted one did.
    expect(readyWhenFirstDrained).toBe(3)
    expect(drains[0]).toEqual({ operationId: 'database-restore-1', epoch: 7 })
    // The acknowledgement is not repeated while the drain keeps going.
    expect(f.calls.filter((call) => call.endsWith('/ready'))).toHaveLength(3)
    const ticks = f.calls.filter((call) => call.startsWith('GET')).length
    expect(drains.length).toBeLessThan(ticks)
    expect(authority.current()).toEqual({ kind: 'frozen', reason: 'database-frozen-by-platform' })
  } finally {
    await authority.close()
  }
})

test('a failing drain pass never stops the freeze ticks and is retried', async () => {
  const f = frozenPlatform()
  const authority = authorityOver(f, 5)
  let attempts = 0
  authority.drainMigrationWith(async () => {
    attempts += 1
    if (attempts === 1) throw new Error('platform unreachable')
    return { remaining: 0 }
  })
  try {
    authority.start()
    await until(() => attempts >= 2)
    expect(authority.current().kind).toBe('frozen')
  } finally {
    await authority.close()
  }
})

const stop = { operationId: 'database-restore-1', epoch: 7 }
const unused = async (): Promise<never> => {
  throw new Error('unexpected platform operation')
}

describeEachProvider('RFC-370 V7 migration writer drain', (harness) => {
  const setup = async () => {
    const tasks = new Map<string, BusinessTask>()
    const subtasks = new Map<string, BusinessSubtask[]>()
    const cancels: { taskId: string; subtaskId: string; request: unknown }[] = []
    const pauses: { taskId: string; request: unknown }[] = []
    let refusePause = false
    const api = {
      getTask: async (id: string) => {
        const task = tasks.get(id)
        if (task === undefined) throw new Error(`unknown parent ${id}`)
        return task
      },
      listSubtasks: async (id: string) => subtasks.get(id) ?? [],
      cancelSubtask: async (taskId: string, subtaskId: string, request: unknown) => {
        cancels.push({ taskId, subtaskId, request })
      },
      pauseTask: async (taskId: string, request: unknown) => {
        if (refusePause)
          throw new CrewStationApiError(409, 'conflict', 'active subtasks', {
            code: 'active_subtasks',
          })
        pauses.push({ taskId, request })
      },
      createTask: unused,
      closeTask: unused,
      finalizeTask: unused,
      resumeTask: unused,
      createMaterial: unused,
      submitSubtask: unused,
      getSubtask: unused,
      events: unused,
      streamEvents: () => {
        throw new Error('unexpected event stream')
      },
      readFile: unused,
      listFiles: unused,
    } satisfies CrewStationBusinessExecution
    const register = async (
      owner: string,
      state: 'creating' | 'ready' | 'closed',
      task: Partial<BusinessTask>,
    ) => {
      const businessTaskId = `cs-${owner}`
      await harness.db.insert(hostedTaskWorkspaces).values({
        taskId: owner,
        requestKey: `aw-task:installation:${owner}`,
        businessTaskId,
        state,
        createdAt: 0,
        updatedAt: 0,
      })
      tasks.set(businessTaskId, { id: businessTaskId, state: 'running', generation: 5, ...task })
      return businessTaskId
    }
    const subtask = (id: string, state: string, attempt = 1) =>
      ({
        id,
        taskId: 'unused',
        kind: 'agent',
        attempt,
        state,
        executionId: `exec-${id}`,
      }) as BusinessSubtask
    const drain = createHostedMigrationDrain({ db: harness.db, api })
    return {
      tasks,
      subtasks,
      cancels,
      pauses,
      register,
      subtask,
      drain,
      refusePause: (value: boolean) => {
        refusePause = value
      },
    }
  }

  test('a running parent has its active subtasks cancelled, and is paused once they have results', async () => {
    const f = await setup()
    const parent = await f.register('system:shared', 'ready', {})
    f.subtasks.set(parent, [
      f.subtask('agent-running', 'running', 2),
      f.subtask('agent-stopping', 'cancelling'),
      f.subtask('agent-done', 'succeeded'),
    ])
    const signal = new AbortController().signal
    expect(await f.drain(stop, signal)).toEqual({ remaining: 1 })
    expect(f.cancels).toEqual([
      {
        taskId: parent,
        subtaskId: 'agent-running',
        request: {
          requestKey:
            'aw-task:installation:system:shared:migration:database-restore-1:cancel:agent-running:2',
          stopAuthority: stop,
          expectedAttempt: 2,
        },
      },
    ])
    // Not paused while a subtask still runs: the platform refuses that.
    expect(f.pauses).toEqual([])
    f.subtasks.set(parent, [
      f.subtask('agent-running', 'cancelled', 2),
      f.subtask('agent-done', 'succeeded'),
    ])
    expect(await f.drain(stop, signal)).toEqual({ remaining: 1 })
    expect(f.pauses).toEqual([
      {
        taskId: parent,
        request: {
          requestKey: 'aw-task:installation:system:shared:migration:database-restore-1:pause:5',
          stopAuthority: stop,
          expectedGeneration: 5,
        },
      },
    ])
    f.tasks.set(parent, { ...f.tasks.get(parent)!, state: 'paused' })
    expect(await f.drain(stop, signal)).toEqual({ remaining: 0 })
    expect(f.pauses).toHaveLength(1)
  })

  test('parents without a running container are left alone and nothing is written to the database', async () => {
    const f = await setup()
    await f.register('task-paused', 'ready', { state: 'paused' })
    await f.register('task-failed', 'ready', { state: 'failed' })
    await f.register('task-closed', 'closed', { state: 'closed' })
    const starting = await f.register('task-starting', 'creating', { state: 'creating' })
    const before = await harness.db.select().from(hostedTaskWorkspaces)
    // A starting container counts as remaining; it is paused once it runs.
    expect(await f.drain(stop, new AbortController().signal)).toEqual({ remaining: 1 })
    expect(f.cancels).toEqual([])
    expect(f.pauses).toEqual([])
    expect(await harness.db.select().from(hostedTaskWorkspaces)).toEqual(before)
    f.tasks.set(starting, { ...f.tasks.get(starting)!, state: 'running' })
    await f.drain(stop, new AbortController().signal)
    expect(f.pauses.map((pause) => pause.taskId)).toEqual([starting])
  })

  test('a lifecycle race is left to the next pass and does not stop the others', async () => {
    const f = await setup()
    await f.register('task-a', 'ready', {})
    await f.register('task-b', 'ready', {})
    f.refusePause(true)
    expect(await f.drain(stop, new AbortController().signal)).toEqual({ remaining: 2 })
    f.refusePause(false)
    await f.drain(stop, new AbortController().signal)
    expect(f.pauses.map((pause) => pause.taskId).sort()).toEqual(['cs-task-a', 'cs-task-b'])
  })
})
