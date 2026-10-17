// RFC-370 §9.2 V4 — AW consumes CrewStation recovery requests for its two
// declared parent-level actions. One request: claim → admission (AW owns the
// task, the requester has an AW account allowed to execute it) → the platform
// operation → AW's ORDINARY resume command once the container runs again.
// Every path ends in a terminal journal state (succeeded / failed / rejected);
// nothing is reserved, deferred indefinitely or replayed from a stale claim.
import { expect, test } from 'bun:test'
import { buildActor, type Actor } from '@/auth/actor'
import { hostedRecoveryRequests } from '@/db/schema'
import {
  CrewStationApiError,
  type CrewStationPlatformApi,
} from '@/platform/crewstation/platformApi'
import { createCrewStationRecoveryApi } from '@/platform/crewstation/recovery'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import { createHostedRecoveryJournal } from '@/modules/task-execution/infrastructure/crewstation/recoveryJournal'
import {
  createHostedRecoveryConsumer,
  type HostedRecoveryBusiness,
} from '@/modules/task-execution/infrastructure/crewstation/recoveryConsumer'
import { describeEachProvider } from './helpers/eachProvider'

const id = (suffix: string) => `01a13e6d-3e00-7000-9e3c-${suffix.padStart(12, '0')}`
const lease = { epoch: 2, leaseId: id('a1'), instanceId: id('a2') }
const actor = buildActor({
  user: {
    id: 'aw-user',
    username: 'operator',
    displayName: 'Operator',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})

describeEachProvider('RFC-370 hosted recovery consumer', (harness) => {
  function setup(options: { action?: string; now?: () => number } = {}) {
    const request = {
      id: id('5'),
      projectId: id('6'),
      serviceId: id('7'),
      requestedBy: id('8'),
      requestKey: 'user-request',
      target: {
        action: options.action ?? 'resume-task',
        taskId: id('1'),
        expectedGeneration: 4,
        materialDigest: 'a'.repeat(64),
        volumeUid: 'volume',
      },
      assessmentDigest: 'b'.repeat(64),
      state: 'claimed',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }
    const platform = {
      offered: [request] as (typeof request)[],
      platformState: 'running' as string,
      platformReason: undefined as string | undefined,
      execute: null as Error | null,
      calls: [] as string[],
      rejected: [] as string[],
    }
    const api: CrewStationPlatformApi = {
      async get() {
        throw new Error('unexpected GET')
      },
      async post<T>(path: string, body: unknown): Promise<T> {
        const leaf = path.split('/').at(-1)!
        platform.calls.push(leaf)
        if (leaf === 'claim') {
          const next = platform.offered.shift()
          return (
            next === undefined
              ? null
              : {
                  request: next,
                  claimId: id('9'),
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                }
          ) as T
        }
        if (leaf === 'read')
          return {
            ...request,
            state: platform.platformState,
            ...(platform.platformReason === undefined ? {} : { reason: platform.platformReason }),
          } as T
        if (leaf === 'reject') {
          platform.rejected.push((body as { reason: string }).reason)
          return { ...request, state: 'rejected' } as T
        }
        if (platform.execute !== null) throw platform.execute
        return { operationId: id('13'), taskId: request.target.taskId, state: 'pending' } as T
      },
      stream() {
        throw new Error('unexpected stream')
      },
    }
    const fence: CrewStationMutationFence = {
      current: () => lease,
      assertHeld: async () => undefined,
    }
    const resumed: string[] = []
    let parentState = 'running'
    const business: HostedRecoveryBusiness & { status: string | null } = {
      status: 'interrupted' as string | null,
      ownerTask: async (businessTaskId) => (businessTaskId === id('1') ? 'aw-task' : null),
      requester: async (requestedBy) => (requestedBy === id('8') ? actor : null),
      assertManualExecutionAllowed: async () => undefined,
      async taskStatus() {
        return business.status
      },
      async resumeTask(by: Actor, taskId) {
        expect(by.user.id).toBe('aw-user')
        resumed.push(taskId)
      },
    }
    const logs: string[] = []
    const consumer = createHostedRecoveryConsumer({
      recovery: createCrewStationRecoveryApi({ api, fence }),
      api: {
        getTask: async () => ({
          id: id('1'),
          state: parentState,
          resourceState: 'ready',
          generation: 5,
        }),
      },
      journal: createHostedRecoveryJournal({ db: harness.db, fence }),
      business,
      log: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    const row = async () => (await harness.db.select().from(hostedRecoveryRequests))[0]
    return {
      request,
      platform,
      business,
      consumer,
      resumed,
      logs,
      row,
      setParent: (state: string) => {
        parentState = state
      },
    }
  }

  test('a declared action runs once, then AW resumes the interrupted task with its ordinary command', async () => {
    const f = setup()
    f.platform.platformState = 'succeeded'
    await f.consumer.tick()
    expect(f.platform.calls).toEqual(['claim', 'resume', 'read', 'claim'])
    expect(f.resumed).toEqual(['aw-task'])
    expect(await f.row()).toMatchObject({
      state: 'succeeded',
      taskId: 'aw-task',
      actorUserId: 'aw-user',
      businessTaskId: id('1'),
    })
    // A finished request is never executed again.
    await f.consumer.tick()
    expect(f.resumed).toEqual(['aw-task'])
  })

  test('rebuild-workspace uses the rebuild operation on the same volume', async () => {
    const f = setup({ action: 'rebuild-workspace' })
    f.platform.platformState = 'succeeded'
    await f.consumer.tick()
    expect(f.platform.calls).toContain('rebuild')
    expect(f.resumed).toEqual(['aw-task'])
  })

  test('while the platform operation runs the request waits; the next tick completes it', async () => {
    const f = setup()
    await f.consumer.tick()
    expect((await f.row())?.state).toBe('executing')
    expect(f.resumed).toEqual([])
    f.platform.platformState = 'succeeded'
    f.setParent('provisioning')
    await f.consumer.tick()
    // The container is not running yet: AW waits instead of resuming early.
    expect((await f.row())?.state).toBe('executing')
    f.setParent('running')
    await f.consumer.tick()
    expect((await f.row())?.state).toBe('succeeded')
    expect(f.resumed).toEqual(['aw-task'])
  })

  test('a task that stopped being resumable meanwhile completes the request without a resume', async () => {
    const f = setup()
    await f.consumer.tick()
    expect((await f.row())?.state).toBe('executing')
    // The user re-ran the task while the platform operation was in flight.
    f.business.status = 'done'
    f.platform.platformState = 'succeeded'
    await f.consumer.tick()
    expect((await f.row())?.state).toBe('succeeded')
    expect(f.resumed).toEqual([])
  })

  test('a failed platform operation is a terminal failure with the platform reason', async () => {
    const f = setup()
    f.platform.platformState = 'failed'
    f.platform.platformReason = 'volume is lost'
    await f.consumer.tick()
    expect(await f.row()).toMatchObject({ state: 'failed', reason: 'volume is lost' })
    expect(f.resumed).toEqual([])
  })

  for (const [name, prepare, reason] of [
    ['an undeclared action', (f: ReturnType<typeof setup>) => f, 'recovery-action-not-supported'],
    [
      'a task AW does not own',
      (f: ReturnType<typeof setup>) => {
        f.business.ownerTask = async () => null
        return f
      },
      'recovery-task-not-owned-by-agent-workflow',
    ],
    [
      'a requester without an AW account',
      (f: ReturnType<typeof setup>) => {
        f.business.requester = async () => null
        return f
      },
      'recovery-requester-has-no-agent-workflow-account',
    ],
    [
      'a requester who cannot execute tasks',
      (f: ReturnType<typeof setup>) => {
        f.business.requester = async () => ({
          ...actor,
          permissions: new Set() as Actor['permissions'],
        })
        return f
      },
      'recovery-requester-cannot-execute-tasks',
    ],
    [
      'a task whose manual execution is not allowed',
      (f: ReturnType<typeof setup>) => {
        f.business.assertManualExecutionAllowed = async () => {
          throw Object.assign(new Error('task is owned by an automation'), {
            code: 'task-manual-execution-denied',
          })
        }
        return f
      },
      'task-manual-execution-denied: task is owned by an automation',
    ],
  ] as const)
    test(`${name} is rejected on the platform and recorded as rejected`, async () => {
      const f = prepare(setup(name === 'an undeclared action' ? { action: 'restart-task' } : {}))
      await f.consumer.tick()
      expect(f.platform.rejected).toEqual([reason])
      expect(f.platform.calls).not.toContain('resume')
      expect(await f.row()).toMatchObject({ state: 'rejected', reason })
      expect(f.resumed).toEqual([])
    })

  test('a resume for a task AW paused itself, or any recovery of a finished task, is rejected', async () => {
    for (const [status, action, reason] of [
      ['awaiting_human', 'resume-task', 'recovery-task-not-resumable: awaiting_human'],
      ['pending', 'resume-task', 'recovery-task-not-resumable: pending'],
      ['done', 'rebuild-workspace', 'recovery-task-finished'],
      [null, 'rebuild-workspace', 'recovery-task-not-found'],
    ] as const) {
      await harness.db.delete(hostedRecoveryRequests)
      const f = setup({ action })
      f.business.status = status
      await f.consumer.tick()
      expect(f.platform.rejected).toEqual([reason])
      expect(f.platform.calls).not.toContain(action === 'resume-task' ? 'resume' : 'rebuild')
    }
  })

  test('rebuild-workspace is admitted for a task that is still running', async () => {
    const f = setup({ action: 'rebuild-workspace' })
    f.business.status = 'running'
    f.platform.platformState = 'succeeded'
    await f.consumer.tick()
    expect(f.platform.calls).toContain('rebuild')
    // The running task is not resumed; it continues on the rebuilt container.
    expect(f.resumed).toEqual([])
    expect((await f.row())?.state).toBe('succeeded')
  })

  test('transient platform failures defer the request until its deadline, then it fails', async () => {
    let clock = Date.now()
    const f = setup({ now: () => clock })
    f.platform.execute = new CrewStationApiError(503, 'unavailable', 'try later', {})
    await f.consumer.tick()
    expect((await f.row())?.state).toBe('admitted')
    // The platform offers the request again after the claim expires.
    f.platform.offered.push(f.request)
    f.platform.execute = null
    f.platform.platformState = 'running'
    await f.consumer.tick()
    expect((await f.row())?.state).toBe('executing')
    clock += 3 * 60 * 60 * 1000
    await f.consumer.tick()
    expect(await f.row()).toMatchObject({ state: 'failed', reason: 'recovery-timed-out' })
  })

  test('a permanent platform refusal fails the request immediately', async () => {
    const f = setup()
    f.platform.execute = new CrewStationApiError(409, 'conflict', 'generation changed', {})
    await f.consumer.tick()
    expect(await f.row()).toMatchObject({ state: 'failed', reason: 'generation changed' })
  })

  test('a request offered again after it finished is rejected with its stored outcome', async () => {
    const f = setup()
    f.platform.platformState = 'failed'
    f.platform.platformReason = 'volume is lost'
    await f.consumer.tick()
    f.platform.offered.push(f.request)
    await f.consumer.tick()
    expect(f.platform.rejected).toEqual(['volume is lost'])
    expect(f.platform.calls.filter((call) => call === 'resume')).toHaveLength(1)
  })
})
