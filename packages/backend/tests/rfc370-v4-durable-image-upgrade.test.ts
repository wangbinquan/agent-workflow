// RFC-370 §10 V21 — durable owners' parents follow the release's task image
// (CS RFC-043).
//
// WHY THIS FILE EXISTS (regression intent): RFC-370 v4 acceptance, 2026-10-19.
// A CrewStation parent keeps the task image it was created with. Scratch
// owners get a parent per release, but AW task volumes and
// `development:shared` keep theirs, so `development:shared` could never run
// the V18 commands (`workspace-helper-operation-unknown`), and a task created
// before a release could never run that release's commands. These tests lock:
// - proactive: the lifecycle reconciler upgrades the paused, idle parent of a
//   durable shared owner whose image differs from the release's, with a
//   per-generation key naming the target, and the next use resumes it on that
//   image; nothing is requested without a declared image, for equal images,
//   for scratch owners or for AW task owners (those upgrade on demand);
// - on demand: a command its parent's image does not know pauses the idle
//   parent, upgrades it and runs once more under its own operation id; a
//   replay and a recovery of the original id follow that run;
// - work still running in a parent is never stopped: the caller gets a
//   retryable 503 `hosted-task-image-upgrade-pending`;
// - scratch owners are never upgraded, and an operation the release's image
//   does not know either is not retried;
// - a failed or refused upgrade leaves the parent on its image and surfaces
//   the platform's reason; a refusal is not requested again right away;
// - a client or platform without the operation never upgrades, and the wire
//   and bootstrap wiring follow the CS RFC-043 contract.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostedTaskWorkspaces, hostedWorkspaceCommands } from '@/db/schema'
import { HostedRuntimeCapabilitiesSchema } from '@/modules/runtime-management/composition/crewstationRuntimeManagement'
import {
  createHostedTaskWorkspaces,
  hostedLifecycleRequestKey,
} from '@/modules/source-control/infrastructure/crewstation/taskWorkspace'
import { createHostedWorkspaceCommands } from '@/modules/source-control/infrastructure/crewstation/workspaceCommands'
import { createHostedWorkspaceImageUpgrades } from '@/modules/source-control/infrastructure/crewstation/workspaceImageUpgrade'
import { createHostedWorkspaceLifecycle } from '@/modules/source-control/infrastructure/crewstation/workspaceLifecycle'
import { createDatabaseHostedExecutionControl } from '@/modules/system-operations/infrastructure/hostedExecutionControl'
import {
  createCrewStationBusinessExecution,
  type BusinessEvent,
  type BusinessOperation,
  type BusinessSubtask,
  type BusinessTask,
  type CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import {
  CrewStationApiError,
  type CrewStationPlatformApi,
} from '@/platform/crewstation/platformApi'
import {
  decodeWorkspaceHelperArguments,
  WorkspaceCommandFailedError,
} from '@/platform/crewstation/workspaceProtocol'
import { DomainError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'

const OLD = 'image-old'
const NEW = 'image-new'
/** Operations only the release's image has. */
const ADDED = new Set(['repository-facts', 'code-review'])
/** An operation no image has. */
const NOWHERE = 'not-an-operation'
const TASK_OWNER = '01JTASKOWNERV21000000000000'

const unused = async (): Promise<never> => {
  throw new Error('unexpected platform operation')
}

type UpgradeRequest = Parameters<
  NonNullable<CrewStationBusinessExecution['upgradeRuntimeImage']>
>[1]
type PauseRequest = Parameters<CrewStationBusinessExecution['pauseTask']>[1]

describeEachProvider('RFC-370 V21 durable parents follow the release task image', (harness) => {
  const lease = { epoch: 1, leaseId: 'lease', instanceId: 'instance' }

  const setup = async (
    options: { readonly target?: string | null; readonly upgradeClient?: boolean } = {},
  ) => {
    const control = createDatabaseHostedExecutionControl({ db: harness.db })
    for (const phase of ['preparing', 'active'] as const)
      await control.write({
        ...lease,
        owner: lease.instanceId,
        phase,
        expiresAt: Date.now() + 60_000,
      })
    const fence: CrewStationMutationFence = {
      current: () => lease,
      assertHeld: (tx, value) => control.assertHeld(tx, value),
    }
    let clock = 10_000_000
    const sleep = async (ms: number) => {
      clock += ms
    }
    let target: string | null = options.target === undefined ? NEW : options.target
    let declarationReads = 0
    let upgradeRefusal: unknown = null
    let upgradeOutcome: 'succeeded' | 'failed' = 'succeeded'
    const parents = new Map<string, BusinessTask>()
    /** Every lifecycle call and command submission, in order. */
    const calls: string[] = []
    const pauses: { taskId: string; request: PauseRequest }[] = []
    const upgrades: { taskId: string; request: UpgradeRequest }[] = []
    const operations = new Map<string, { view: BusinessOperation; target: string }>()
    /** Subtasks other than workspace commands (an agent run, …). */
    const otherWork = new Map<string, BusinessSubtask[]>()
    const commandSubtasks: BusinessSubtask[] = []
    const byKey = new Map<string, BusinessSubtask>()
    const results = new Map<string, BusinessEvent>()
    const files = new Map<string, string>()
    const conflict = (code: string) => new CrewStationApiError(409, 'conflict', code, { code })
    const parent = (id: string) => {
      const value = parents.get(id)
      if (value === undefined) throw new Error(`unknown parent ${id}`)
      return value
    }
    const update = (id: string, patch: Partial<BusinessTask>) => {
      parents.set(id, { ...parent(id), ...patch })
    }
    const api: CrewStationBusinessExecution = {
      createTask: unused,
      closeTask: unused,
      finalizeTask: unused,
      createMaterial: unused,
      getSubtask: unused,
      cancelSubtask: unused,
      listFiles: unused,
      streamEvents: () => {
        throw new Error('unexpected event stream')
      },
      getTask: async (id) => parent(id),
      async pauseTask(id, request) {
        calls.push(`pause:${id}`)
        pauses.push({ taskId: id, request })
        const current = parent(id)
        if (request.expectedGeneration !== current.generation) throw conflict('stale_generation')
        if (current.state !== 'running' && current.state !== 'paused')
          throw conflict('task_not_running')
        update(id, {
          state: 'paused',
          resourceState: 'released',
          generation: current.generation + 1,
        })
      },
      async resumeTask(id, request) {
        calls.push(`resume:${id}`)
        const current = parent(id)
        if (request.expectedGeneration !== current.generation) throw conflict('stale_generation')
        if (current.state !== 'paused') throw conflict('task_not_paused')
        update(id, { state: 'running', resourceState: 'ready', generation: current.generation + 1 })
      },
      async upgradeRuntimeImage(id, request) {
        calls.push(`upgrade:${id}`)
        upgrades.push({ taskId: id, request })
        if (upgradeRefusal !== null) throw upgradeRefusal
        const current = parent(id)
        if (request.expectedGeneration !== current.generation) throw conflict('stale_generation')
        if (current.state !== 'paused') throw conflict('task_not_paused')
        const view: BusinessOperation = {
          operationId: `op-${operations.size + 1}`,
          taskId: id,
          state: 'pending',
        }
        operations.set(view.operationId, { view, target: request.runtimeImageVersionId ?? NEW })
        update(id, { generation: current.generation + 1 })
        return view
      },
      // The platform finishes the re-pin by the first poll.
      async getOperation(id, operationId) {
        const operation = operations.get(operationId)!
        if (operation.view.state === 'pending') {
          operation.view =
            upgradeOutcome === 'succeeded'
              ? { ...operation.view, state: 'succeeded' }
              : { ...operation.view, state: 'failed', message: 'image_unavailable' }
          if (upgradeOutcome === 'succeeded')
            update(id, { runtimeImage: { versionId: operation.target } })
        }
        return operation.view
      },
      listSubtasks: async (id) => [
        ...commandSubtasks.filter((subtask) => subtask.taskId === id),
        ...(otherWork.get(id) ?? []),
      ],
      // The helper of the parent's current image runs the command at once.
      async submitSubtask(id, request) {
        const current = parent(id)
        if (current.state !== 'running') throw conflict('task_paused')
        const existing = byKey.get(request.requestKey)
        if (existing !== undefined) return existing
        if (request.kind !== 'command') throw new Error('unexpected agent subtask')
        const helper = decodeWorkspaceHelperArguments(request.argv.slice(2))
        const image = current.runtimeImage!.versionId
        calls.push(`submit:${helper.operation}@${image}`)
        const subtask: BusinessSubtask = {
          id: `sub-${commandSubtasks.length + 1}`,
          taskId: id,
          kind: 'command',
          attempt: 1,
          state: 'succeeded',
          executionId: `exec-${commandSubtasks.length + 1}`,
        }
        commandSubtasks.push(subtask)
        byKey.set(request.requestKey, subtask)
        const known =
          helper.operation !== NOWHERE && (image === NEW || !ADDED.has(helper.operation))
        files.set(
          `${id}:${helper.resultPath.replace(/^\/work\//, '')}`,
          JSON.stringify(
            known
              ? { ok: true, value: { ran: helper.operation, on: image } }
              : {
                  ok: false,
                  error: {
                    code: 'Error',
                    message: `workspace-helper-operation-unknown: ${helper.operation}`,
                  },
                },
          ),
        )
        const cursor = `${subtask.id}:end`
        results.set(subtask.id, {
          taskId: id,
          subtaskId: subtask.id,
          attempt: 1,
          cursor,
          sourceEventId: cursor,
          occurredAt: new Date(0).toISOString(),
          type: 'result',
          data: {
            exitCode: 0,
            reason: 'completed',
            stdout: '',
            stderr: '',
            truncated: false,
            finalCursor: cursor,
          },
        })
        return subtask
      },
      events: async (_id, query) => {
        const result = results.get(query.subtaskId ?? '')
        return { items: result === undefined ? [] : [result], hasMore: false, nextCursor: null }
      },
      async readFile(id, query) {
        const content = files.get(`${id}:${query.path}`)
        if (content === undefined) throw new CrewStationApiError(404, 'not-found', 'no file', {})
        const bytes = Buffer.from(content)
        return {
          path: query.path,
          version: 'v1',
          size: bytes.length,
          offset: 0,
          contentBase64: bytes.toString('base64'),
          nextOffset: null,
        }
      },
    }
    const client: CrewStationBusinessExecution =
      options.upgradeClient === false
        ? { ...api, upgradeRuntimeImage: undefined, getOperation: undefined }
        : api
    const workspaces = createHostedTaskWorkspaces({
      db: harness.db,
      api: client,
      fence,
      installation: 'project/service',
      taskContractVersion: 'aw-task-v1',
      now: () => clock,
      sleep,
    })
    const imageUpgrades = createHostedWorkspaceImageUpgrades({
      db: harness.db,
      api: client,
      fence,
      releaseTaskImage: async () => {
        declarationReads += 1
        return target
      },
      hasUnsettledCommands: (businessTaskId) => commands.hasUnsettledCommands(businessTaskId),
      now: () => clock,
      sleep,
    })
    const commands = createHostedWorkspaceCommands({
      db: harness.db,
      fence,
      api: client,
      workspaces,
      imageUpgrades,
      now: () => clock,
    })
    const lifecycle = createHostedWorkspaceLifecycle({
      db: harness.db,
      api: client,
      fence,
      workspaces,
      commands,
      activity: { activeVolumeOwners: async () => new Set<string>() },
      held: () => false,
      imageUpgrades,
      now: () => clock,
    })
    /** A registered parent, idle since long ago, on the earlier image. */
    const register = async (owner: string, platform: Partial<BusinessTask> = {}) => {
      const id = `cs-${owner}`
      await harness.db.insert(hostedTaskWorkspaces).values({
        taskId: owner,
        requestKey: `aw-task:installation:${owner}`,
        businessTaskId: id,
        state: 'ready',
        createdAt: 0,
        updatedAt: 0,
      })
      parents.set(id, {
        id,
        state: 'running',
        resourceState: 'ready',
        generation: 5,
        runtimeImage: { versionId: OLD },
        ...platform,
      })
      return id
    }
    return {
      commands,
      register,
      parents,
      calls,
      pauses,
      upgrades,
      otherWork,
      pass: () => lifecycle.pass(new AbortController().signal),
      journal: async () =>
        (await harness.db.select().from(hostedWorkspaceCommands))
          .map((row) => `${row.executionId} ${row.state}`)
          .sort(),
      advance: (ms: number) => {
        clock += ms
      },
      setTarget: (value: string | null) => {
        target = value
      },
      refuseUpgrades: (error: unknown) => {
        upgradeRefusal = error
      },
      failUpgradeOperations: () => {
        upgradeOutcome = 'failed'
      },
      declarationReads: () => declarationReads,
    }
  }
  const paused = { state: 'paused', resourceState: 'released' } as const

  test('an idle durable parent is paused, upgraded on the next pass and resumed on the release image', async () => {
    const f = await setup()
    const id = await f.register('development:shared')
    expect(await f.pass()).toEqual({ paused: ['development:shared'], closed: [], failed: [] })
    expect(f.upgrades).toEqual([])
    expect(await f.pass()).toEqual({
      paused: [],
      closed: [],
      failed: [],
      upgraded: ['development:shared'],
    })
    // The key names the generation and the target; the fence is the lease's.
    expect(f.upgrades).toEqual([
      {
        taskId: id,
        request: {
          requestKey: hostedLifecycleRequestKey(
            `aw-task:installation:development:shared@${sha256Hex(NEW).slice(0, 16)}`,
            'upgrade',
            6,
          ),
          fence: lease,
          expectedGeneration: 6,
          runtimeImageVersionId: NEW,
        },
      },
    ])
    expect(f.parents.get(id)).toMatchObject({ state: 'paused', runtimeImage: { versionId: NEW } })
    // Already on the release's image: nothing more is requested.
    expect(await f.pass()).toEqual({ paused: [], closed: [], failed: [] })
    expect(f.upgrades).toHaveLength(1)
    // Its next use resumes it on that image; the command the old image lacked runs.
    expect(await f.commands.call('development:shared', 'repository-facts', {})).toEqual({
      ran: 'repository-facts',
      on: NEW,
    })
    expect(f.calls).toEqual([
      `pause:${id}`,
      `upgrade:${id}`,
      `resume:${id}`,
      `submit:repository-facts@${NEW}`,
    ])
  })

  test('nothing is upgraded proactively without a declared image, for equal images, scratch or task owners', async () => {
    const f = await setup({ target: null })
    await f.register('development:shared', paused)
    expect(await f.pass()).toEqual({ paused: [], closed: [], failed: [] })
    expect(f.upgrades).toEqual([])
    // The release declares its image (read again once the cached answer ages).
    f.setTarget(NEW)
    f.advance(60_001)
    await f.register('development:current', { ...paused, runtimeImage: { versionId: NEW } })
    await f.register('development:unreported', { ...paused, runtimeImage: null })
    await f.register('system:shared', paused)
    await f.register(TASK_OWNER, paused)
    expect(await f.pass()).toEqual({
      paused: [],
      closed: [],
      failed: [],
      upgraded: ['development:shared'],
    })
    expect(f.upgrades.map((upgrade) => upgrade.taskId)).toEqual(['cs-development:shared'])
  })

  test('on demand: an unknown command upgrades the idle parent and runs once more under its own id', async () => {
    const f = await setup()
    const id = await f.register('development:shared')
    expect(
      await f.commands.call(
        'development:shared',
        'repository-facts',
        { a: 1 },
        { operationId: 'facts-1' },
      ),
    ).toEqual({ ran: 'repository-facts', on: NEW })
    expect(f.calls).toEqual([
      `submit:repository-facts@${OLD}`,
      `pause:${id}`,
      `upgrade:${id}`,
      `resume:${id}`,
      `submit:repository-facts@${NEW}`,
    ])
    // The pause is the lifecycle's per-generation one; the upgrade names the target.
    expect(f.pauses).toEqual([
      {
        taskId: id,
        request: {
          requestKey: hostedLifecycleRequestKey(
            'aw-task:installation:development:shared',
            'pause',
            5,
          ),
          fence: lease,
          expectedGeneration: 5,
        },
      },
    ])
    expect(f.upgrades[0]?.request).toMatchObject({
      fence: lease,
      expectedGeneration: 6,
      runtimeImageVersionId: NEW,
    })
    expect(await f.journal()).toEqual([
      'command:development:shared:facts-1 settled',
      'command:development:shared:facts-1:image-upgraded settled',
    ])
    // A replay and a recovery of the original id follow the second run.
    expect(
      await f.commands.call(
        'development:shared',
        'repository-facts',
        { a: 1 },
        { operationId: 'facts-1' },
      ),
    ).toEqual({ ran: 'repository-facts', on: NEW })
    expect(await f.commands.recover('development:shared', 'facts-1')).toEqual({
      value: { ran: 'repository-facts', on: NEW },
    })
    expect(f.calls).toHaveLength(5)
  })

  test("on demand: an AW task's paused parent is resumed, upgraded and resumed again", async () => {
    const f = await setup()
    const id = await f.register(TASK_OWNER, paused)
    expect(await f.commands.call(TASK_OWNER, 'code-review', { path: 'a.ts' })).toEqual({
      ran: 'code-review',
      on: NEW,
    })
    expect(f.calls).toEqual([
      `resume:${id}`,
      `submit:code-review@${OLD}`,
      `pause:${id}`,
      `upgrade:${id}`,
      `resume:${id}`,
      `submit:code-review@${NEW}`,
    ])
  })

  test('work still running in the parent is never stopped for an upgrade', async () => {
    const f = await setup()
    const id = await f.register('development:shared')
    f.otherWork.set(id, [
      {
        id: 'agent-1',
        taskId: id,
        kind: 'agent',
        attempt: 1,
        state: 'running',
        executionId: 'exec-agent',
      },
    ])
    const error = await f.commands
      .call('development:shared', 'repository-facts', {})
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({
      code: 'hosted-task-image-upgrade-pending',
      status: 503,
      details: { owner: 'development:shared', currentVersionId: OLD, targetVersionId: NEW },
    })
    expect(f.calls).toEqual([`submit:repository-facts@${OLD}`])
    expect(f.parents.get(id)).toMatchObject({ state: 'running', runtimeImage: { versionId: OLD } })
    // Once nothing runs in it, the next call upgrades it.
    f.otherWork.delete(id)
    expect(await f.commands.call('development:shared', 'repository-facts', {})).toEqual({
      ran: 'repository-facts',
      on: NEW,
    })
    expect(f.calls.slice(1)).toEqual([
      `submit:repository-facts@${OLD}`,
      `pause:${id}`,
      `upgrade:${id}`,
      `resume:${id}`,
      `submit:repository-facts@${NEW}`,
    ])
  })

  test('scratch owners are never upgraded, and an operation no image has is not retried', async () => {
    const f = await setup()
    const scratch = await f.register('system:shared')
    const unknown = await f.commands
      .call('system:shared', 'repository-facts', {})
      .catch((e: unknown) => e)
    expect(unknown).toBeInstanceOf(WorkspaceCommandFailedError)
    expect((unknown as Error).message).toBe('workspace-helper-operation-unknown: repository-facts')
    expect(f.calls).toEqual([`submit:repository-facts@${OLD}`])
    // Nor proactively, paused and idle.
    f.parents.set(scratch, { ...f.parents.get(scratch)!, ...paused })
    f.advance(600_001)
    expect(await f.pass()).toEqual({ paused: [], closed: [], failed: [] })
    expect(f.upgrades).toEqual([])
    // A durable owner already on the release's image: the error stands.
    await f.register('development:current', { runtimeImage: { versionId: NEW } })
    const nowhere = await f.commands
      .call('development:current', NOWHERE, {})
      .catch((e: unknown) => e)
    expect((nowhere as Error).message).toBe(`workspace-helper-operation-unknown: ${NOWHERE}`)
    expect(f.calls).toEqual([`submit:repository-facts@${OLD}`, `submit:${NOWHERE}@${NEW}`])
  })

  test('the command runs again only once after an upgrade', async () => {
    const f = await setup()
    const id = await f.register('development:shared')
    const error = await f.commands
      .call('development:shared', NOWHERE, {}, { operationId: 'nowhere-1' })
      .catch((e: unknown) => e)
    expect((error as Error).message).toBe(`workspace-helper-operation-unknown: ${NOWHERE}`)
    expect(f.calls).toEqual([
      `submit:${NOWHERE}@${OLD}`,
      `pause:${id}`,
      `upgrade:${id}`,
      `resume:${id}`,
      `submit:${NOWHERE}@${NEW}`,
    ])
    expect(await f.journal()).toEqual([
      'command:development:shared:nowhere-1 settled',
      'command:development:shared:nowhere-1:image-upgraded settled',
    ])
  })

  test('a failed upgrade leaves the parent paused on its image and surfaces the platform reason', async () => {
    const f = await setup()
    const id = await f.register('development:shared')
    f.failUpgradeOperations()
    const error = await f.commands
      .call('development:shared', 'repository-facts', {})
      .catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: 'hosted-task-image-upgrade-failed',
      status: 502,
      details: {
        owner: 'development:shared',
        currentVersionId: OLD,
        targetVersionId: NEW,
        platformCode: 'image_unavailable',
      },
    })
    expect(f.parents.get(id)).toMatchObject({ state: 'paused', runtimeImage: { versionId: OLD } })
    expect(f.calls).toEqual([`submit:repository-facts@${OLD}`, `pause:${id}`, `upgrade:${id}`])
  })

  test('a refused upgrade is reported once and not requested again right away', async () => {
    const f = await setup()
    await f.register('development:shared', paused)
    f.refuseUpgrades(
      new CrewStationApiError(409, 'conflict', 'different image', {
        code: 'runtime_image_mismatch',
      }),
    )
    // A permanent refusal is not a lifecycle race.
    expect(await f.pass()).toEqual({ paused: [], closed: [], failed: ['development:shared'] })
    expect(await f.pass()).toEqual({ paused: [], closed: [], failed: [] })
    expect(f.upgrades).toHaveLength(1)
    // On demand the same reason comes back without another request.
    const remembered = await f.commands
      .call('development:shared', 'repository-facts', {})
      .catch((e: unknown) => e)
    expect(remembered).toMatchObject({
      code: 'hosted-task-image-upgrade-failed',
      status: 502,
      details: { platformCode: 'runtime_image_mismatch' },
    })
    expect(f.upgrades).toHaveLength(1)
    // Later it is requested again.
    f.advance(600_001)
    const again = await f.commands
      .call('development:shared', 'repository-facts', {})
      .catch((e: unknown) => e)
    expect(again).toMatchObject({ details: { platformCode: 'runtime_image_mismatch' } })
    expect(f.upgrades).toHaveLength(2)
  })

  test('a client without the operation never upgrades', async () => {
    const f = await setup({ upgradeClient: false })
    await f.register('development:shared', paused)
    expect(await f.pass()).toEqual({ paused: [], closed: [], failed: [] })
    const error = await f.commands
      .call('development:shared', 'repository-facts', {})
      .catch((e: unknown) => e)
    expect((error as Error).message).toBe('workspace-helper-operation-unknown: repository-facts')
    expect(f.upgrades).toEqual([])
    expect(f.declarationReads()).toBe(0)
  })
})

test('the client speaks the CS RFC-043 upgrade and operation routes', async () => {
  const requests: { method: string; path: string; body?: unknown }[] = []
  const platform: CrewStationPlatformApi = {
    get: async <T>(path: string) => {
      requests.push({ method: 'GET', path })
      return { operationId: 'op/1', taskId: 'task/1', state: 'succeeded' } as T
    },
    post: async <T>(path: string, body: unknown) => {
      requests.push({ method: 'POST', path, body })
      return { operationId: 'op/1', taskId: 'task/1', state: 'pending' } as T
    },
    stream: () => {
      throw new Error('unexpected event stream')
    },
  }
  const client = createCrewStationBusinessExecution(platform)
  const request = {
    requestKey: 'key',
    fence: { epoch: 1, leaseId: 'lease', instanceId: 'instance' },
    expectedGeneration: 3,
    runtimeImageVersionId: NEW,
  }
  expect(await client.upgradeRuntimeImage!('task/1', request)).toMatchObject({ state: 'pending' })
  expect(await client.getOperation!('task/1', 'op/1')).toMatchObject({ state: 'succeeded' })
  expect(requests).toEqual([
    { method: 'POST', path: '/v3/business-tasks/task%2F1/runtime-image', body: request },
    { method: 'GET', path: '/v3/business-tasks/task%2F1/operations/op%2F1' },
  ])
})

test('the release image is declared only when the platform can upgrade a parent', () => {
  const base = { protocolVersion: 3, releaseId: 'release', agentProfiles: [] }
  expect(
    HostedRuntimeCapabilitiesSchema.parse({
      ...base,
      runtimeImageUpgrade: 1,
      taskRuntimeImageVersionId: NEW,
    }),
  ).toMatchObject({ runtimeImageUpgrade: 1, taskRuntimeImageVersionId: NEW })
  const older = HostedRuntimeCapabilitiesSchema.parse(base)
  expect(older.runtimeImageUpgrade).toBeUndefined()
  expect(older.taskRuntimeImageVersionId).toBeUndefined()
  const bootstrap = readFileSync(join(import.meta.dir, '../src/bootstrap/crewstation.ts'), 'utf8')
  expect(bootstrap).toContain(
    'current.runtimeImageUpgrade === 1 ? (current.taskRuntimeImageVersionId ?? null) : null',
  )
  const owner = readFileSync(
    join(import.meta.dir, '../src/modules/source-control/composition/crewstationWorkspace.ts'),
    'utf8',
  )
  expect(owner).toMatch(/createHostedWorkspaceCommands\(\{[\s\S]*?imageUpgrades,/)
  expect(owner).toMatch(/createHostedWorkspaceLifecycle\(\{[\s\S]*?imageUpgrades,/)
})
