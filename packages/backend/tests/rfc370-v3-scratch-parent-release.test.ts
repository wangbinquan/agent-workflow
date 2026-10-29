// RFC-370 hosted acceptance (2026-10-17) — a scratch owner's parent follows the
// running release.
//
// WHY THIS FILE EXISTS (regression intent): a CrewStation parent keeps the task
// image it was created with. The shared system scratch parent (`system:shared`)
// created under an early release stayed in use under every later one, so each
// memory distillation failed in it with the old image's
// `hosted-git-credential-bindings-invalid`; nothing ever replaced it. Scratch
// owners (`system:…`, `mcp-test:…`) now get a parent per release, and one the
// platform closed or can no longer run is replaced. AW task volumes and durable
// shared owners (`development:shared`) keep their parent.
//
// 2026-10-19: the first runtime probe after a release switch failed after 300 s
// with `hosted-workspace-provisioning-timeout: … still closing`: replacing the
// superseded `system:shared` parent waited for its physical release, and
// CrewStation took about eight minutes to finalize it. The replacement now
// waits only until the platform accepted the close. It also retires only the
// registration it read, so a concurrent use that re-armed the owner first
// keeps its new parent.
//
// 2026-10-19 (v4): a running superseded parent was kept until the lifecycle
// reconciler found it idle for ten minutes, and every use reset that clock — so
// after the v0.6.24 switch the release's new task-image commands
// (`repository-remote`, `execution-contract-fixture`) failed with
// `workspace-helper-operation-unknown` on the old image while system work kept
// the parent busy. A superseded parent now keeps serving only while the
// platform still runs subtasks in it; with nothing in flight the running
// release gets its own parent at once.
//
// CrewStation RFC-044 T10 (2026-10-29): the formal instance's retired
// `system:shared` parent stayed in finalization for nine days. The platform
// waited for the app to cancel an agent subtask that was never dispatched, and
// AW only kept asking whether the parent was released; the running container
// then held a database migration's freeze. A close the platform accepted now
// cancels what is still stranded in the parent.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createHostedTaskWorkspaces } from '@/modules/source-control/infrastructure/crewstation/taskWorkspace'
import { createDatabaseHostedExecutionControl } from '@/modules/system-operations/infrastructure/hostedExecutionControl'
import type {
  BusinessTask,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'

const unused = async (): Promise<never> => {
  throw new Error('unexpected platform operation')
}

describeEachProvider('RFC-370 scratch parents follow the running release', (harness) => {
  const lease = { epoch: 1, leaseId: 'lease', instanceId: 'instance' }
  const setup = async (options: { completionPolicy?: 'archive-and-delete' } = {}) => {
    const control = createDatabaseHostedExecutionControl({ db: harness.db })
    for (const phase of ['preparing', 'active'] as const)
      await control.write({
        ...lease,
        owner: lease.instanceId,
        phase,
        expiresAt: Date.now() + 60_000,
      })
    const parents = new Map<string, BusinessTask>()
    const byKey = new Map<string, string>()
    const created: string[] = []
    const closedParents: string[] = []
    const finalized: string[] = []
    const cancels: { taskId: string; subtaskId: string; request: unknown }[] = []
    const running = new Map<string, readonly { id: string; state: string; attempt: number }[]>()
    let beforeGetTask: ((id: string) => Promise<void>) | null = null
    const api: CrewStationBusinessExecution = {
      createTask: async (request) => {
        let id = byKey.get(request.requestKey)
        if (id === undefined) {
          id = `parent-${byKey.size + 1}`
          byKey.set(request.requestKey, id)
          created.push(request.requestKey)
          parents.set(id, {
            id,
            state: 'running',
            resourceState: 'ready',
            generation: 1,
            ...(options.completionPolicy === undefined
              ? {}
              : { completionPolicy: options.completionPolicy }),
          })
        }
        return parents.get(id)!
      },
      // The answer reflects the parent when the request was served, even when
      // the response is held back (`beforeGetTask`).
      getTask: async (id) => {
        const observed = parents.get(id)!
        if (beforeGetTask !== null) await beforeGetTask(id)
        return observed
      },
      closeTask: async (id) => {
        closedParents.push(id)
        const parent = parents.get(id)!
        parents.set(id, {
          ...parent,
          state: 'closed',
          resourceState: 'released',
          generation: parent.generation + 1,
        })
      },
      resumeTask: async (id) => {
        parents.set(id, { ...parents.get(id)!, state: 'running', resourceState: 'ready' })
      },
      // Archive-and-delete: accepted at once, released whenever the platform
      // gets to it (the test decides).
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
      pauseTask: unused,
      listSubtasks: async (id) => (running.get(id) ?? []) as never,
      createMaterial: unused,
      submitSubtask: unused,
      getSubtask: unused,
      cancelSubtask: async (taskId, subtaskId, request) => {
        cancels.push({ taskId, subtaskId, request })
      },
      events: unused,
      streamEvents: () => {
        throw new Error('unexpected event stream')
      },
      readFile: unused,
      listFiles: unused,
    }
    let release: string | null = 'release-1'
    let clock = 1_000_000
    const workspaces = createHostedTaskWorkspaces({
      db: harness.db,
      api,
      installation: 'project/service',
      taskContractVersion: 'aw-task-v1',
      fence: { current: () => lease, assertHeld: (tx, value) => control.assertHeld(tx, value) },
      release: async () => release,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })
    const row = async (owner: string) => {
      const { hostedTaskWorkspaces } = tablesOf(harness.db)
      return (
        await harness.db
          .select()
          .from(hostedTaskWorkspaces)
          .where(eq(hostedTaskWorkspaces.taskId, owner))
      )[0]!
    }
    return {
      workspaces,
      parents,
      created,
      closedParents,
      finalized,
      cancels,
      row,
      elapsed: () => clock - 1_000_000,
      holdGetTask: (hook: ((id: string) => Promise<void>) | null) => {
        beforeGetTask = hook
      },
      setRelease: (value: string | null) => {
        release = value
      },
      setParent: (id: string, patch: Partial<BusinessTask>) => {
        parents.set(id, { ...parents.get(id)!, ...patch })
      },
      setSubtasks: (id: string, states: readonly string[]) => {
        running.set(
          id,
          states.map((state, index) => ({ id: `subtask-${index}`, state, attempt: 1 })),
        )
      },
    }
  }
  const releaseTag = (release: string) => `@${sha256Hex(release).slice(0, 16)}`

  test('a parent of another release that no longer runs is replaced on the next use', async () => {
    const f = await setup()
    const first = await f.workspaces.ensure('system:shared')
    expect((await f.row('system:shared')).requestKey.endsWith(releaseTag('release-1'))).toBe(true)
    f.setParent(first.businessTaskId, { state: 'paused', resourceState: 'released' })
    f.setRelease('release-2')
    expect(await f.workspaces.superseded('system:shared')).toBe(true)
    const second = await f.workspaces.ensure('system:shared')
    expect(second.businessTaskId).not.toBe(first.businessTaskId)
    expect(f.closedParents).toEqual([first.businessTaskId])
    expect((await f.row('system:shared')).requestKey.endsWith(releaseTag('release-2'))).toBe(true)
    expect(await f.workspaces.superseded('system:shared')).toBe(false)
  })

  test('a running parent of another release keeps serving while it still runs work', async () => {
    const f = await setup()
    const first = await f.workspaces.ensure('system:intent')
    f.setSubtasks(first.businessTaskId, ['succeeded', 'running'])
    f.setRelease('release-2')
    expect(await f.workspaces.ensure('system:intent')).toEqual(first)
    expect(f.closedParents).toEqual([])
    // The lifecycle reconciler retires it once idle (it reads `superseded`).
    expect(await f.workspaces.superseded('system:intent')).toBe(true)
  })

  test('a running parent of another release with nothing in flight is replaced at once', async () => {
    const f = await setup()
    const first = await f.workspaces.ensure('system:shared')
    f.setSubtasks(first.businessTaskId, ['succeeded', 'failed', 'cancelled'])
    f.setRelease('release-2')
    const second = await f.workspaces.ensure('system:shared')
    expect(second.businessTaskId).not.toBe(first.businessTaskId)
    expect(f.closedParents).toEqual([first.businessTaskId])
    expect((await f.row('system:shared')).requestKey.endsWith(releaseTag('release-2'))).toBe(true)
    expect(await f.workspaces.superseded('system:shared')).toBe(false)
  })

  test('a parent the platform failed or released is replaced under the same release', async () => {
    const f = await setup()
    const first = await f.workspaces.ensure('mcp-test:01SESSION')
    f.setParent(first.businessTaskId, {
      state: 'failed',
      resourceState: 'failed',
      message: '容器不存在',
    })
    const second = await f.workspaces.ensure('mcp-test:01SESSION')
    expect(second.businessTaskId).not.toBe(first.businessTaskId)
    expect(f.closedParents).toEqual([first.businessTaskId])
    const key = (await f.row('mcp-test:01SESSION')).requestKey
    expect(key).toContain(`${releaseTag('release-1')}~`)
    expect(await f.workspaces.superseded('mcp-test:01SESSION')).toBe(false)
    const { hostedTaskWorkspaces } = tablesOf(harness.db)
    // A registration the platform released (recorded closed) is re-armed too.
    await harness.db
      .update(hostedTaskWorkspaces)
      .set({ state: 'closed' })
      .where(eq(hostedTaskWorkspaces.taskId, 'mcp-test:01SESSION'))
    const third = await f.workspaces.ensure('mcp-test:01SESSION')
    expect(new Set([first, second, third].map((w) => w.businessTaskId)).size).toBe(3)
  })

  test('task volumes and durable shared owners keep their parent across releases', async () => {
    const f = await setup()
    const task = await f.workspaces.ensure('01TASK')
    const development = await f.workspaces.ensure('development:shared')
    expect(f.created.every((key) => !key.includes('@'))).toBe(true)
    f.setRelease('release-2')
    f.setParent(development.businessTaskId, { state: 'paused', resourceState: 'released' })
    expect(await f.workspaces.ensure('01TASK')).toEqual(task)
    expect(await f.workspaces.ensure('development:shared')).toEqual(development)
    expect(f.closedParents).toEqual([])
    expect(await f.workspaces.superseded('development:shared')).toBe(false)
    // A closed AW task volume is never reopened.
    await f.workspaces.close('01TASK')
    await expect(f.workspaces.ensure('01TASK')).rejects.toThrow('hosted-workspace-closed')
  })

  // RFC-370 hosted acceptance (2026-10-19): the platform refused the
  // `development:shared` volume for a full PVC quota and failed its parent
  // before any volume existed; every development Case was then blocked on
  // "rebuild the workspace", which needs the original volume. A durable shared
  // owner now replaces a failed parent that never had a volume; one with a
  // volume, and an AW task's parent, keep the recovery path.
  test("a durable shared owner's parent that failed before its volume existed is replaced", async () => {
    const f = await setup()
    const first = await f.workspaces.ensure('development:shared')
    f.setParent(first.businessTaskId, {
      state: 'failed',
      resourceState: 'failed',
      message: '容器不存在',
      volumeUid: null,
    })
    const second = await f.workspaces.ensure('development:shared')
    expect(second.businessTaskId).not.toBe(first.businessTaskId)
    expect(f.closedParents).toEqual([first.businessTaskId])
    expect((await f.row('development:shared')).requestKey).toContain('development:shared~')
    f.setParent(second.businessTaskId, {
      state: 'failed',
      resourceState: 'failed',
      message: '容器运行失败',
      volumeUid: 'volume-1',
    })
    await expect(f.workspaces.ensure('development:shared')).rejects.toMatchObject({
      code: 'hosted-workspace-unavailable',
    })
    const task = await f.workspaces.ensure('01TASK')
    f.setParent(task.businessTaskId, {
      state: 'failed',
      resourceState: 'failed',
      message: '容器不存在',
      volumeUid: null,
    })
    await expect(f.workspaces.ensure('01TASK')).rejects.toMatchObject({
      code: 'hosted-workspace-unavailable',
    })
    expect(f.closedParents).toEqual([first.businessTaskId])
  })

  test('a retired parent the platform is still finalizing does not hold its replacement', async () => {
    const f = await setup({ completionPolicy: 'archive-and-delete' })
    const first = await f.workspaces.ensure('system:shared')
    f.setParent(first.businessTaskId, { state: 'paused', resourceState: 'released' })
    f.setRelease('release-2')
    const second = await f.workspaces.ensure('system:shared')
    expect(second.businessTaskId).not.toBe(first.businessTaskId)
    // Finalized once and still being released by the platform: nobody waited.
    expect(f.finalized).toEqual([first.businessTaskId])
    expect(f.parents.get(first.businessTaskId)).toMatchObject({
      state: 'finalizing',
      resourceState: 'releasing',
    })
    expect(f.elapsed()).toBe(0)
    expect(await f.row('system:shared')).toMatchObject({
      businessTaskId: second.businessTaskId,
      state: 'ready',
    })
    expect((await f.row('system:shared')).requestKey.endsWith(releaseTag('release-2'))).toBe(true)
  })

  test('a close waiting on a stranded subtask cancels it under the lease and completes once released', async () => {
    const f = await setup({ completionPolicy: 'archive-and-delete' })
    const parent = (await f.workspaces.ensure('system:shared')).businessTaskId
    const requestKey = (await f.row('system:shared')).requestKey
    f.setSubtasks(parent, ['succeeded', 'pending', 'cancelling'])
    expect(await f.workspaces.close('system:shared')).toBe(false)
    expect(f.finalized).toEqual([parent])
    expect(f.cancels).toEqual([
      {
        taskId: parent,
        subtaskId: 'subtask-1',
        request: {
          requestKey: `${requestKey}:cancel:subtask-1:1`,
          fence: lease,
          expectedAttempt: 1,
        },
      },
    ])
    expect(await f.row('system:shared')).toMatchObject({ state: 'closing' })
    f.setSubtasks(parent, ['succeeded', 'cancelled', 'cancelled'])
    f.setParent(parent, { state: 'closed', resourceState: 'released' })
    expect(await f.workspaces.close('system:shared')).toBe(true)
    expect(f.cancels).toHaveLength(1)
    expect(await f.row('system:shared')).toMatchObject({ state: 'closed' })
  })

  test('a concurrent use that re-armed the owner first keeps its new parent', async () => {
    const f = await setup()
    const first = await f.workspaces.ensure('system:shared')
    f.setParent(first.businessTaskId, { state: 'paused', resourceState: 'released' })
    f.setRelease('release-2')
    // The slow use reads the superseded registration, then its observation of
    // the old parent is held back while another use replaces the parent.
    let held: (() => void) | null = null
    let reached: () => void = () => undefined
    const atGate = new Promise<void>((resolve) => {
      reached = resolve
    })
    f.holdGetTask(async (id) => {
      if (id !== first.businessTaskId || held !== null) return
      await new Promise<void>((resolve) => {
        held = resolve
        reached()
      })
    })
    const slow = f.workspaces.ensure('system:shared')
    await atGate
    const fast = await f.workspaces.ensure('system:shared')
    expect(fast.businessTaskId).not.toBe(first.businessTaskId)
    held!()
    expect(await slow).toEqual(fast)
    // Only the superseded parent was ever closed; the new one keeps running.
    expect(f.closedParents).toEqual([first.businessTaskId])
    expect(f.parents.get(fast.businessTaskId)?.state).toBe('running')
    expect(await f.row('system:shared')).toMatchObject({
      businessTaskId: fast.businessTaskId,
      state: 'ready',
    })
  })

  test('without a known release a scratch owner keeps the release-free key', async () => {
    const f = await setup()
    f.setRelease(null)
    const first = await f.workspaces.ensure('system:shared')
    expect((await f.row('system:shared')).requestKey.includes('@')).toBe(false)
    f.setParent(first.businessTaskId, { state: 'paused', resourceState: 'released' })
    expect(await f.workspaces.ensure('system:shared')).toEqual(first)
    expect(await f.workspaces.superseded('system:shared')).toBe(false)
    // Once the release is known the release-free parent is replaced when unused.
    f.setRelease('release-1')
    f.setParent(first.businessTaskId, { state: 'paused', resourceState: 'released' })
    expect((await f.workspaces.ensure('system:shared')).businessTaskId).not.toBe(
      first.businessTaskId,
    )
  })
})
