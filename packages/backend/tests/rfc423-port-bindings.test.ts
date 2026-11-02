// RFC-423: the last adapter logic left task-execution composition. These cases lock the moved bodies on their
// infrastructure owners: the trigger participant's launch / cancel; the hosted recovery selection refusing a changed
// database, consuming nothing while this instance does not hold the execution authority and, over a real database,
// resolving the owner task and the requester through its business closure and resuming the task as that requester;
// the worker maintenance's protected task set (set for one phase, cleared after it even when the phase fails); and the
// preparation GC phase routing.
import { expect, test } from 'bun:test'
import { buildActor } from '@/auth/actor'
import { createTaskExecutionTriggerParticipant } from '@/modules/task-execution/infrastructure/taskExecutionTrigger'
import { createHostedRecoverySelection } from '@/modules/task-execution/infrastructure/crewstation/hostedRecoverySelection'
import {
  createWorkerWorkspaceMaintenance,
  createWorkspacePreparationMaintenance,
} from '@/modules/task-execution/infrastructure/workspacePreparationGc'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationPlatformApi } from '@/platform/crewstation/platformApi'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { describeEachProvider } from './helpers/eachProvider'
import { patchTaskFixture } from './helpers/model'
import { seedTask } from './helpers/questionDispatchFixture'

test('the trigger participant launches through the launches and cancels as the user', async () => {
  const calls: unknown[] = []
  const participant = createTaskExecutionTriggerParticipant({
    launches: {
      async launch(request: unknown) {
        calls.push(['launch', request])
        return { id: 'task-1' }
      },
    } as never,
    cancellation: {
      async cancel(input: unknown) {
        calls.push(['cancel', input])
      },
    } as never,
  })
  const request = { target: { kind: 'workflow', refId: 'wf-1' } }
  expect(await participant.launch(request as never)).toEqual({ taskId: 'task-1' })
  await participant.cancel('task-1')
  expect(calls).toEqual([
    ['launch', request],
    ['cancel', { taskId: 'task-1', cause: { kind: 'user' } }],
  ])
})

test('a hosted recovery selection refuses a context over another database', () => {
  const selection = createHostedRecoverySelection({
    db: { sentinel: 'db' } as never,
    fence: { current: () => ({ sentinel: 'fence' }) } as never,
    platform: {} as never,
    api: { getTask: async () => null } as never,
    log: { info() {}, warn() {} },
    requesterFor: () => ({ resolve: async () => null }),
  })
  expect(() =>
    selection({ directAuthority: {} } as never)({
      db: { sentinel: 'other-db' },
      assertManualExecutionAllowed: async () => undefined,
      resumeTaskAs: async () => undefined,
    } as never),
  ).toThrow('hosted-recovery-provider-changed')
})

const uuid = (suffix: string) => `01a13e6d-3e00-7000-9e3c-${suffix.padStart(12, '0')}`
const lease = { epoch: 2, leaseId: uuid('a1'), instanceId: uuid('a2') }
const operator = buildActor({
  user: {
    id: 'aw-user',
    username: 'operator',
    displayName: 'Operator',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})

describeEachProvider('RFC-423 hosted recovery selection over a real database', (harness) => {
  test('it consumes only under the execution authority and resumes the owned task as the requester', async () => {
    await seedTask(harness.db, 'aw-task')
    await patchTaskFixture(harness.db, { id: 'aw-task' }, { status: 'interrupted' })
    const { hostedRecoveryRequests, hostedTaskWorkspaces } = tablesOf(harness.db)
    await insertOne(harness.db, hostedTaskWorkspaces, {
      taskId: 'aw-task',
      requestKey: 'aw-task:installation:aw-task',
      businessTaskId: uuid('1'),
      state: 'ready',
      createdAt: 0,
      updatedAt: 0,
    })
    const request = {
      id: uuid('5'),
      projectId: uuid('6'),
      serviceId: uuid('7'),
      requestedBy: uuid('8'),
      requestKey: 'user-request',
      target: {
        action: 'resume-task',
        taskId: uuid('1'),
        expectedGeneration: 4,
        materialDigest: 'a'.repeat(64),
        volumeUid: 'volume',
      },
      assessmentDigest: 'b'.repeat(64),
      state: 'claimed',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }
    const offered = [request]
    const calls: string[] = []
    const platform: CrewStationPlatformApi = {
      async get() {
        throw new Error('unexpected GET')
      },
      async post<T>(path: string): Promise<T> {
        const leaf = path.split('/').at(-1)!
        calls.push(leaf)
        if (leaf === 'claim') {
          const next = offered.shift()
          return (
            next === undefined
              ? null
              : {
                  request: next,
                  claimId: uuid('9'),
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                }
          ) as T
        }
        if (leaf === 'read') return { ...request, state: 'succeeded' } as T
        return { operationId: uuid('13'), taskId: request.target.taskId, state: 'pending' } as T
      },
      stream() {
        throw new Error('unexpected stream')
      },
    }
    let held = false
    const fence: CrewStationMutationFence = {
      current() {
        if (!held) throw new Error('fence-not-held')
        return lease
      },
      assertHeld: async () => undefined,
    }
    const identityAccess = { directAuthority: {} } as never
    const allowed: unknown[] = []
    const resumed: unknown[] = []
    const selection = createHostedRecoverySelection({
      db: harness.db,
      fence,
      platform,
      api: {
        getTask: async () =>
          ({ id: uuid('1'), state: 'running', resourceState: 'ready', generation: 5 }) as never,
      },
      log: { info() {}, warn() {} },
      requesterFor: (received) => {
        expect(received).toBe(identityAccess)
        return {
          resolve: async (requestedBy) =>
            requestedBy === uuid('8') ? ({ actor: operator } as never) : null,
        }
      },
    })
    const recovery = selection(identityAccess)({
      db: harness.db,
      assertManualExecutionAllowed: async (actor, taskId) => {
        allowed.push([actor.user.id, taskId])
      },
      resumeTaskAs: async (actor, taskId) => {
        resumed.push([actor.user.id, taskId])
      },
    })

    // Another instance holds the execution authority: the platform is never asked.
    await recovery.tick()
    expect(calls).toEqual([])
    expect(await harness.db.select().from(hostedRecoveryRequests)).toEqual([])

    held = true
    await recovery.tick()
    expect(calls).toEqual(['claim', 'resume', 'read', 'claim'])
    expect(allowed).toEqual([['aw-user', 'aw-task']])
    expect(resumed).toEqual([['aw-user', 'aw-task']])
    expect((await harness.db.select().from(hostedRecoveryRequests))[0]).toMatchObject({
      state: 'succeeded',
      taskId: 'aw-task',
      actorUserId: 'aw-user',
      businessTaskId: uuid('1'),
    })
  })
})

test('the worker maintenance protects the active tasks for one phase and clears them after, even on failure', async () => {
  const observed: unknown[] = []
  let fail = false
  const command = createWorkerWorkspaceMaintenance((isMaterializingTask) => ({
    async runGcPhase(input: unknown) {
      observed.push([isMaterializingTask('task-1'), isMaterializingTask('task-2')])
      if (fail) throw new Error('phase failed')
      return { input } as never
    },
    async recover(input: unknown) {
      observed.push(['recover', input])
      return undefined as never
    },
  }))
  await command.runGcPhase({ phase: 'orphan', activeTaskIds: ['task-1'] } as never)
  fail = true
  await expect(
    command.runGcPhase({ phase: 'orphan', activeTaskIds: ['task-2'] } as never),
  ).rejects.toThrow('phase failed')
  fail = false
  await command.runGcPhase({ phase: 'orphan', activeTaskIds: [] } as never)
  await command.recover({ taskId: 'task-1' } as never)
  expect(observed).toEqual([
    [true, false],
    [false, true],
    [false, false],
    ['recover', { taskId: 'task-1' }],
  ])
})

test('the preparation maintenance delegates every phase except orphan and scratch', async () => {
  const delegated: unknown[] = []
  const command = createWorkspacePreparationMaintenance({
    db: {} as never,
    appHome: '/home',
    repositoryPreparation: {} as never,
    maintenance: {
      async runGcPhase(request: unknown) {
        delegated.push(request)
        return { delegated: true } as never
      },
      async recover() {
        return undefined as never
      },
    } as never,
  })
  const request = { phase: 'retention', activeTaskIds: [] }
  expect(await command.runGcPhase(request as never)).toEqual({ delegated: true } as never)
  expect(delegated).toEqual([request])
})
