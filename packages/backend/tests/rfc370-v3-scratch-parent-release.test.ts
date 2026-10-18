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
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { hostedTaskWorkspaces } from '@/db/schema'
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
    const byKey = new Map<string, string>()
    const created: string[] = []
    const closedParents: string[] = []
    const api: CrewStationBusinessExecution = {
      createTask: async (request) => {
        let id = byKey.get(request.requestKey)
        if (id === undefined) {
          id = `parent-${byKey.size + 1}`
          byKey.set(request.requestKey, id)
          created.push(request.requestKey)
          parents.set(id, { id, state: 'running', resourceState: 'ready', generation: 1 })
        }
        return parents.get(id)!
      },
      getTask: async (id) => parents.get(id)!,
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
    const row = async (owner: string) =>
      (
        await harness.db
          .select()
          .from(hostedTaskWorkspaces)
          .where(eq(hostedTaskWorkspaces.taskId, owner))
      )[0]!
    return {
      workspaces,
      parents,
      created,
      closedParents,
      row,
      setRelease: (value: string | null) => {
        release = value
      },
      setParent: (id: string, patch: Partial<BusinessTask>) => {
        parents.set(id, { ...parents.get(id)!, ...patch })
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

  test('a running parent of another release keeps serving until it is replaced when idle', async () => {
    const f = await setup()
    const first = await f.workspaces.ensure('system:intent')
    f.setRelease('release-2')
    expect(await f.workspaces.ensure('system:intent')).toEqual(first)
    expect(f.closedParents).toEqual([])
    // The lifecycle reconciler retires it once idle (it reads `superseded`).
    expect(await f.workspaces.superseded('system:intent')).toBe(true)
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
