// RFC-388: both deployments preserve claim lifetime, legacy receipts, active/stop semantics and injected seams.
import type { TaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskExecutionModule } from '@/modules/task-execution/composition'
import { composeDaemonTaskExecutionModules } from '@/bootstrap/daemonModules/taskExecution'
import { clearTaskDriverLifecycleForTesting } from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import { describeEachProvider } from './helpers/eachProvider'
import { taskBundleInput, seedBundleTask } from './helpers/daemonTaskExecutionBundle'
import { attachTestTaskRuntime } from './helpers/taskRuntimeRegistry'

const homes: string[] = []
function home() {
  const path = mkdtempSync(join(tmpdir(), 'rfc388-runtime-'))
  homes.push(path)
  return path
}
afterEach(() => {
  clearTaskDriverLifecycleForTesting()
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true })
})

describeEachProvider('RFC-388 neutral task execution runtime', (harness) => {
  test('adapter preserves its hot-apply key and passive process/session lifetime', () => {
    const fixture = taskBundleInput(harness, home())
    const binding = harness.applicationBinding
    expect(fixture.input.adapters.processConcurrencyScope).toBe(
      binding.provider === 'sqlite' ? binding.db : binding.runtime,
    )
    expect(Object.keys(fixture.input.adapters).sort()).toEqual([
      'execution',
      'processConcurrencyScope',
      'provider',
    ])
    const statements = harness.recordStatements()
    const interval = spyOn(globalThis, 'setInterval')
    const timeout = spyOn(globalThis, 'setTimeout')
    try {
      const first = fixture.compose()
      const second = fixture.compose()
      expect(statements.statements).toHaveLength(0)
      expect(interval).not.toHaveBeenCalled()
      expect(timeout).not.toHaveBeenCalled()
      expect(Object.isFrozen(first)).toBe(true)
      expect(first).not.toHaveProperty('provider')
      expect(first.coordinator).toBe(first.coordinatorFactory.session)
      expect(first.runtime.schedulerDriver).toBe(fixture.schedulerDriver)
      expect(first.runtime.topology.schedulerDriver).toBe(fixture.schedulerDriver)
      expect(first.persistence.reads).toBe(first.readModels)
      if (binding.provider === 'sqlite') {
        expect(first.executionModule).toBe(taskExecutionModule)
        expect(first.executionModule).toBe(second.executionModule)
      } else {
        expect(first.executionModule).not.toBe(second.executionModule)
        expect(first.executionModule.runtimeRegistry).not.toBe(
          second.executionModule.runtimeRegistry,
        )
      }
    } finally {
      statements.stop()
      interval.mockRestore()
      timeout.mockRestore()
    }
  })

  test('the selected claim attaches once, retains legacy receipts and releases through the same registry', async () => {
    const appHome = home()
    const fixture = taskBundleInput(harness, appHome)
    const finalized: string[] = []
    const bundle = composeDaemonTaskExecutionModules({
      ...fixture.input,
      finalizeWorkspace: async (taskId) => {
        finalized.push(taskId)
      },
    })
    const { taskId, intentId } = await seedBundleTask(harness, appHome)
    const controller = new AbortController()
    const attached = await bundle.driverLifecycle.attach({ taskId, intentId, controller })
    expect(attached.kind).toBe('attached')
    if (attached.kind !== 'attached') throw new Error('expected an attached driver')
    try {
      const context = attached.attachment.execution as TaskExecutionContext
      expect(context.persistence).toBe(bundle.persistence)
      expect(context.legacyConnection).toBe(
        harness.applicationBinding.provider === 'sqlite' ? harness.db : undefined,
      )
      expect(bundle.isTaskActive(taskId)).toBe(true)
      expect(bundle.participants.activity.isActive(taskId)).toBe(true)
      expect(bundle.activeTaskIds()).toContain(taskId)
      const token = attached.attachment.execution.token
      const ticket = bundle.executionModule.runtimeRegistry.requestStop(token, 'rfc388-stop')
      expect(controller.signal.aborted).toBe(true)
      expect(controller.signal.reason).toBe('rfc388-stop')
      await bundle.driverLifecycle.releaseAndFinalize({ taskId, controller })
      expect((await bundle.executionModule.runtimeRegistry.awaitStopped(ticket)).kind).toBe(
        'released',
      )
      await bundle.participants.activity.awaitReleasedSettled(taskId)
      expect(bundle.participants.activity.isActive(taskId)).toBe(false)
      expect(bundle.activeTaskIds()).not.toContain(taskId)
      expect(finalized).toEqual([taskId])
    } finally {
      await bundle.driverLifecycle.releaseAndFinalize({ taskId, controller })
    }
  })

  test('activity waits through the released-but-unsettled window without a separate test hook', async () => {
    const bundle = taskBundleInput(harness, home()).compose()
    const registered = attachTestTaskRuntime(bundle.executionModule, 'rfc388-active-task')
    const registry = bundle.executionModule.runtimeRegistry
    expect(bundle.participants.activity.isActive('rfc388-active-task')).toBe(true)
    registry.release({ token: registered.token, controller: registered.controller })
    let settled = false
    const pending = bundle.participants.activity
      .awaitReleasedSettled('rfc388-active-task')
      .then(() => {
        settled = true
      })
    await Promise.resolve()
    expect(settled).toBe(false)
    registry.settle(registered.token)
    await pending
    expect(settled).toBe(true)
    expect(bundle.participants.activity.isActive('rfc388-active-task')).toBe(false)
  })
})
