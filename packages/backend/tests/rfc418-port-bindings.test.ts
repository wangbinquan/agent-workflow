// RFC-418: the provider-session background control moved from composition into task-execution application and now
// reaches the legacy sweeps, the cadence constants, the file configuration source and the scheduled-task runner only
// through ports. These cases drive the application control with fake ports: every loop reads its cadence when it arms,
// a due loop calls its bound sweep with the configured arguments, a switched-off loop calls nothing, start keeps its
// source selection and guards, and stop drains the module's tickets. The binding's own start mapping stays covered by
// rfc370-task-background-configuration (it runs the real scheduled operations through composition).
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROVIDER_SESSION_CLOSE_ABORT_REASON } from '@agent-workflow/shared'
import { createTaskExecutionProviderBackground } from '@/modules/task-execution/application/providerBackground'
import type { ProviderBackgroundControl } from '@/modules/task-execution/application/ports/providerBackground'

const controls: ProviderBackgroundControl[] = []
afterEach(async () => {
  for (const control of controls.splice(0)) await control.stop()
})

const enabled = {
  autoRepair: { 'stuck-running': true, 'other-rule': false },
  maxAutoRecoveriesPerWindow: 3,
  autoRecoveryWindowMs: 1_000,
  autoKillStalledChild: true,
  heartbeatStallMs: 500,
  periodicOrphanReconcileMs: 1,
  scheduledTasksEnabled: true,
  scheduledTasksMaxFailures: 4,
  defaultRuntime: 'opencode',
  autoResumeOnBoot: true,
} as never

const disabled = {
  autoRepair: {},
  maxAutoRecoveriesPerWindow: 3,
  autoRecoveryWindowMs: 1_000,
  autoKillStalledChild: false,
  heartbeatStallMs: 500,
  periodicOrphanReconcileMs: 0,
  scheduledTasksEnabled: false,
  scheduledTasksMaxFailures: 4,
  defaultRuntime: null,
  autoResumeOnBoot: false,
} as never

function backgroundPorts(cadenceMs: number) {
  const calls: unknown[][] = []
  const reads = {
    autoRepairMs: 0,
    autoKillMs: 0,
    orphanReconcileSupervisoryMs: 0,
    scheduleTickMs: 0,
  }
  const read = (name: keyof typeof reads) => () => {
    reads[name] += 1
    return cadenceMs
  }
  const ports = {
    module: {
      pause: async (reason: string) => {
        calls.push(['pause', reason])
        return [{ token: { taskId: 'task-1' } }]
      },
      resume: () => void calls.push(['resume']),
      dispose: async (reason: string) => {
        calls.push(['dispose', reason])
        return [{ token: { taskId: 'task-1' } }]
      },
      awaitIdle: async () => undefined,
      runtimeRegistry: {
        awaitStopped: async (ticket: { token: { taskId: string } }) =>
          void calls.push(['awaitStopped', ticket.token.taskId]),
      },
    },
    lifecycleRepair: { run: async (input: unknown) => void calls.push(['lifecycleRepair', input]) },
    autoResume: { run: async (input: unknown) => void calls.push(['autoResume', input]) },
    cadence: {
      autoRepairMs: read('autoRepairMs'),
      autoKillMs: read('autoKillMs'),
      orphanReconcileSupervisoryMs: read('orphanReconcileSupervisoryMs'),
      scheduleTickMs: read('scheduleTickMs'),
    },
    fileConfiguration: (configPath: string) => {
      calls.push(['fileConfiguration', configPath])
      return { read: () => disabled }
    },
    sweeps: {
      heartbeatKill: async (input: unknown) => void calls.push(['heartbeatKill', input]),
      orphanReconcile: async () => void calls.push(['orphanReconcile']),
    },
  }
  const scheduled = { runDue: async (input: unknown) => void calls.push(['runDue', input]) }
  return { ports: ports as never, calls, reads, scheduled }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}

const first = (calls: unknown[][], name: string) => calls.find((call) => call[0] === name)

test('every loop reads its cadence when it arms and a due loop runs its bound sweep', async () => {
  const { ports, calls, reads, scheduled } = backgroundPorts(5)
  const control = createTaskExecutionProviderBackground(ports)
  controls.push(control)
  await control.start({ configuration: { read: () => enabled }, scheduled })
  expect(reads).toEqual({
    autoRepairMs: 1,
    autoKillMs: 1,
    orphanReconcileSupervisoryMs: 1,
    scheduleTickMs: 1,
  })
  await until(() =>
    ['lifecycleRepair', 'heartbeatKill', 'orphanReconcile', 'runDue', 'autoResume'].every(
      (name) => first(calls, name) !== undefined,
    ),
  )
  expect(first(calls, 'lifecycleRepair')).toEqual([
    'lifecycleRepair',
    { enabledRules: ['stuck-running'], maxPerWindow: 3, windowMs: 1_000 },
  ])
  const kill = first(calls, 'heartbeatKill')![1] as Record<string, unknown>
  expect(kill.breaker).toEqual({ maxPerWindow: 3, windowMs: 1_000 })
  expect(kill.heartbeatStallMs).toBe(500)
  expect(typeof kill.occurredAt).toBe('number')
  expect(first(calls, 'runDue')).toEqual(['runDue', { maxFailures: 4, defaultRuntime: 'opencode' }])
  expect(first(calls, 'autoResume')).toEqual([
    'autoResume',
    { breaker: { maxPerWindow: 3, windowMs: 1_000 } },
  ])
  expect(reads.autoRepairMs).toBeGreaterThan(1)
  await control.stop()
  expect(calls).toContainEqual(['dispose', PROVIDER_SESSION_CLOSE_ABORT_REASON])
  expect(calls).toContainEqual(['awaitStopped', 'task-1'])
})

test('switched-off loops keep waking but call no sweep, repair or scheduled run', async () => {
  const { ports, calls, reads, scheduled } = backgroundPorts(2)
  const control = createTaskExecutionProviderBackground(ports)
  controls.push(control)
  await control.start({ configuration: { read: () => disabled }, scheduled })
  await until(() => reads.orphanReconcileSupervisoryMs > 3 && reads.scheduleTickMs > 3)
  for (const name of [
    'lifecycleRepair',
    'heartbeatKill',
    'orphanReconcile',
    'runDue',
    'autoResume',
  ])
    expect(first(calls, name)).toBeUndefined()
})

test('start selects the file source, requires one source and runs at most once', async () => {
  const fromFile = backgroundPorts(60_000)
  const control = createTaskExecutionProviderBackground(fromFile.ports)
  controls.push(control)
  await control.start({ configPath: '/etc/aw/config.json', scheduled: fromFile.scheduled })
  expect(first(fromFile.calls, 'fileConfiguration')).toEqual([
    'fileConfiguration',
    '/etc/aw/config.json',
  ])
  await expect(control.start({ scheduled: fromFile.scheduled })).rejects.toThrow(
    'task-execution-provider-background-already-started',
  )
  const missing = backgroundPorts(60_000)
  const unsourced = createTaskExecutionProviderBackground(missing.ports)
  controls.push(unsourced)
  await expect(unsourced.start({ scheduled: missing.scheduled })).rejects.toThrow(
    'task-background-configuration-required',
  )
  await expect(unsourced.start({ scheduled: missing.scheduled })).rejects.toThrow(
    'task-execution-provider-background-already-started',
  )
  const stoppedFirst = createTaskExecutionProviderBackground(backgroundPorts(60_000).ports)
  await stoppedFirst.stop()
  await expect(
    stoppedFirst.start({ configuration: { read: () => disabled }, scheduled: missing.scheduled }),
  ).rejects.toThrow('task-execution-provider-background-stopped')
})

test('the binding reads every cadence from the daemon constants on each arm', () => {
  const binding = readFileSync(
    resolve(import.meta.dir, '../src/modules/task-execution/composition/providerBackground.ts'),
    'utf8',
  )
  for (const line of [
    'autoRepairMs: () => DAEMON_CADENCE.autoRepair,',
    'autoKillMs: () => DAEMON_CADENCE.autoKill,',
    'orphanReconcileSupervisoryMs: () => DAEMON_CADENCE.orphanReconcileSupervisory,',
    'scheduleTickMs: () => DAEMON_CADENCE.scheduledTasks,',
    'fileConfiguration: (configPath) => createFileTaskBackgroundConfigurationQuery(configPath),',
  ])
    expect(binding).toContain(line)
})
