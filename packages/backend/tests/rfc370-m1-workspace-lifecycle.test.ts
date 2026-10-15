import { expect, test } from 'bun:test'
import { createHostedTaskWorkspaces } from '@/modules/source-control/infrastructure/crewstation/taskWorkspace'
import { createDatabaseHostedExecutionControl } from '@/modules/system-operations/infrastructure/hostedExecutionControl'
import type {
  BusinessTask,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import { describeEachProvider } from './helpers/eachProvider'

const unused = async (): Promise<never> => {
  throw new Error('unexpected platform operation')
}
describeEachProvider('RFC-370 persistent workspace lifecycle', (harness) => {
  const setup = async () => {
    const lease = { epoch: 1, leaseId: 'lease', instanceId: 'instance' }
    const control = createDatabaseHostedExecutionControl({ db: harness.db })
    for (const phase of ['preparing', 'active'] as const)
      await control.write({
        ...lease,
        owner: lease.instanceId,
        phase,
        expiresAt: Date.now() + 60_000,
      })
    const calls: Parameters<CrewStationBusinessExecution['createTask']>[0][] = []
    let task: BusinessTask = {
      id: 'parent',
      state: 'running',
      resourceState: 'ready',
      generation: 1,
    }
    let createsLost = 0,
      closes = 0
    const api: CrewStationBusinessExecution = {
      createTask: async (request) => {
        calls.push(request)
        if (createsLost-- > 0) throw new Error('create ACK lost')
        return task
      },
      getTask: async () => task,
      closeTask: async () => {
        closes++
        task = { ...task, state: 'closing' }
      },
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
    const workspace = createHostedTaskWorkspaces({
      db: harness.db,
      api,
      installation: 'project/service',
      taskContractVersion: 'aw-task-v1',
      fence: { current: () => lease, assertHeld: (tx, value) => control.assertHeld(tx, value) },
      sleep: async () => {
        throw new Error('unexpected provisioning wait')
      },
    })
    return {
      workspace,
      calls,
      api,
      loseCreate: () => {
        createsLost = 1
      },
      setTask: (value: BusinessTask) => {
        task = value
      },
      closes: () => closes,
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

  test('close ACK hides the workspace but physical release is required before cleanup completes', async () => {
    const f = await setup()
    await f.workspace.ensure('task')
    expect(await f.workspace.close('task')).toBe(false)
    expect(await f.workspace.find('task')).toBeNull()
    expect(await f.workspace.list()).toEqual([])
    await expect(f.workspace.ensure('task')).rejects.toThrow('hosted-workspace-closed')
    f.setTask({ id: 'parent', state: 'closed', resourceState: 'releasing', generation: 1 })
    expect(await f.workspace.close('task')).toBe(false)
    f.setTask({ id: 'parent', state: 'closed', resourceState: 'released', generation: 1 })
    expect(await f.workspace.close('task')).toBe(true)
    expect(await f.workspace.close('task')).toBe(true)
    expect(f.closes()).toBe(1)
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
})
