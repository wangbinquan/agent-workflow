import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MaintenanceWorkerEvent } from '@/platform/background/maintenanceProtocol'
import {
  createColdMaintenanceWorkerSupervisor,
  type ColdMaintenanceWorkerSupervisor,
} from '@/platform/background/maintenanceWorkerSupervisor'
import { createMaintenanceRunStore } from '@/platform/persistence/maintenanceRunStore'
import { describeEachProvider } from './helpers/eachProvider'
import { openProviderMaintenanceWorkerDatabase } from './helpers/providerMaintenanceWorker'

const effectsModule = new URL(
  './fixtures/rfc370-maintenance-worker-channel-effects.mjs',
  import.meta.url,
).href

interface Phase {
  readonly type: string
  readonly instanceRef: string
}

async function removeClosedWorkerHome(appHome: string): Promise<void> {
  if (process.platform === 'win32') {
    // The protocol drain and both database closes precede this cleanup. Let the
    // terminated native Worker finish between attempts; a persistent lock still
    // fails the original strict removal, and other errors propagate immediately.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      Bun.gc(true)
      try {
        rmSync(appHome, { recursive: true, force: true })
        return
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EBUSY') throw error
      }
      await Bun.sleep(100)
    }
    Bun.gc(true)
  }
  rmSync(appHome, { recursive: true, force: true })
}

function phaseChannel() {
  const name = `rfc370-cold-real-drain-${randomUUID()}`
  const channel = new BroadcastChannel(name)
  const received: Phase[] = []
  const pending = new Map<string, (phase: Phase) => void>()
  channel.onmessage = (event) => {
    const phase = event.data as Phase
    const resolvePhase = pending.get(phase.type)
    if (resolvePhase === undefined) received.push(phase)
    else {
      pending.delete(phase.type)
      resolvePhase(phase)
    }
  }
  return {
    name,
    release(phase: string) {
      channel.postMessage({ type: `release-${phase}` })
    },
    async wait(type: string): Promise<Phase> {
      const index = received.findIndex((phase) => phase.type === type)
      if (index !== -1) return received.splice(index, 1)[0]!
      let timer!: ReturnType<typeof setTimeout>
      try {
        return await new Promise<Phase>((resolvePhase, reject) => {
          timer = setTimeout(() => {
            pending.delete(type)
            reject(new Error(`cold-worker-phase-timeout:${type}`))
          }, 15_000)
          pending.set(type, resolvePhase)
        })
      } finally {
        clearTimeout(timer)
      }
    },
    close() {
      channel.close()
    },
  }
}

describeEachProvider('RFC-370 cold maintenance actual Worker drain', (harness) => {
  test('a ready child keeps an existing durable queue untouched until global activation', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc370-worker-global-activation-'))
    const database = openProviderMaintenanceWorkerDatabase(harness, appHome)
    const store = createMaintenanceRunStore(database.db),
      phases = phaseChannel()
    const runId = randomUUID(),
      events: MaintenanceWorkerEvent[] = []
    let actualWorker: { postMessage(message: unknown): void } | undefined
    const supervisor = createColdMaintenanceWorkerSupervisor({
      appHome,
      databaseInit: database.databaseInit,
      dispatchPaused: true,
      workerFactory() {
        const worker =
          database.workerFactory === undefined
            ? new Worker(
                new URL('../src/platform/background/maintenanceWorker.ts', import.meta.url).href,
              )
            : database.workerFactory()
        actualWorker = worker
        return worker
      },
      effectsBootstrap: {
        moduleSpecifier: effectsModule,
        exportName: 'createEffects',
        configurationJson: JSON.stringify({ channelName: phases.name, holdCollect: true }),
        capabilities: ['pluginGenerationGc'],
      },
      onEvent: (event) => {
        events.push(event)
      },
    })
    try {
      await store.enqueue({
        id: runId,
        jobKey: 'pluginGenerationGc',
        jobClass: 'cleanup',
        slotKey: runId,
        payload: {},
        scheduledAt: 0,
        now: 0,
      })
      await supervisor.start()
      expect(events.filter((event) => event.type === 'ready')).toHaveLength(1)
      // Exercise the real child gate as well as the supervisor's wake gate.
      // The selected environment reports this same inbound frame after routing.
      actualWorker!.postMessage({ type: 'wake', version: 1 })
      await phases.wait('wake-received')
      expect(await store.read(runId)).toMatchObject({ state: 'pending', attempt: 0 })
      expect(events.some((event) => event.type === 'active')).toBe(false)
      supervisor.activateDispatch()
      await phases.wait('gc-collect-entered')
      expect(await store.read(runId)).toMatchObject({ state: 'running', attempt: 1 })
      supervisor.quiesce()
      const draining = supervisor.awaitDrained(15_000)
      await phases.wait('drain-received')
      phases.release('collect')
      await draining
      expect(await store.read(runId)).toMatchObject({ state: 'succeeded', attempt: 1 })
      expect(events.filter((event) => event.type === 'drained')).toHaveLength(1)
    } finally {
      phases.release('collect')
      try {
        await supervisor.stop(15_000)
      } finally {
        phases.close()
        await database.close()
        await removeClosedWorkerHome(appHome)
      }
    }
  }, 60_000)

  test('cold construction claims nothing and loss waits for actual job, effect and database close', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc370-cold-worker-real-drain-'))
    const database = openProviderMaintenanceWorkerDatabase(harness, appHome)
    const store = createMaintenanceRunStore(database.db)
    const phases = phaseChannel()
    const runId = randomUUID(),
      nextRunId = randomUUID()
    const events: MaintenanceWorkerEvent[] = []
    let workerCreations = 0
    let supervisor: ColdMaintenanceWorkerSupervisor | undefined
    let completedResolve!: (event: Extract<MaintenanceWorkerEvent, { type: 'completed' }>) => void
    const completed = new Promise<Extract<MaintenanceWorkerEvent, { type: 'completed' }>>(
      (resolve) => {
        completedResolve = resolve
      },
    )
    const failures: unknown[] = []
    try {
      await store.enqueue({
        id: runId,
        jobKey: 'pluginGenerationGc',
        jobClass: 'cleanup',
        slotKey: runId,
        payload: {},
        scheduledAt: 0,
        now: 0,
      })
      supervisor = createColdMaintenanceWorkerSupervisor({
        appHome,
        databaseInit: database.databaseInit,
        workerFactory() {
          workerCreations += 1
          return database.workerFactory === undefined
            ? new Worker(
                new URL('../src/platform/background/maintenanceWorker.ts', import.meta.url).href,
              )
            : database.workerFactory()
        },
        effectsBootstrap: {
          moduleSpecifier: effectsModule,
          exportName: 'createEffects',
          configurationJson: JSON.stringify({
            channelName: phases.name,
            holdInit: true,
            holdCollect: true,
            holdDispose: true,
          }),
          capabilities: ['pluginGenerationGc'],
        },
        onEvent(event) {
          events.push(event)
          if (event.type === 'completed' && event.runId === runId) completedResolve(event)
        },
      })
      supervisor.wake()
      expect(supervisor.live().state).toBe('stopped')
      expect(workerCreations).toBe(0)
      expect(await store.read(runId)).toMatchObject({ state: 'pending', attempt: 0 })

      const starting = supervisor.start()
      let ready = false
      void starting.then(
        () => {
          ready = true
        },
        () => undefined,
      )
      const factory = await phases.wait('factory-entered')
      expect(workerCreations).toBe(1)
      expect(ready).toBe(false)
      expect(await store.read(runId)).toMatchObject({ state: 'pending', attempt: 0 })
      phases.release('init')
      await starting
      const collecting = await phases.wait('gc-collect-entered')
      expect(collecting.instanceRef).toBe(factory.instanceRef)
      expect(await store.read(runId)).toMatchObject({ state: 'running', attempt: 1 })

      supervisor.quiesce()
      let drained = false
      const draining = supervisor.awaitDrained(15_000).then(() => {
        drained = true
      })
      void draining.catch(() => undefined)
      await phases.wait('drain-received')
      supervisor.wake()
      await store.enqueue({
        id: nextRunId,
        jobKey: 'pluginGenerationGc',
        jobClass: 'cleanup',
        slotKey: nextRunId,
        payload: {},
        scheduledAt: 0,
        now: 0,
      })
      expect(drained).toBe(false)
      expect(events.some((event) => event.type === 'completed')).toBe(false)
      expect(workerCreations).toBe(1)

      phases.release('collect')
      const disposing = await phases.wait('dispose-entered')
      expect(disposing.instanceRef).toBe(factory.instanceRef)
      expect(await completed).toMatchObject({ outcome: 'succeeded', counters: { removed: 1 } })
      expect(await store.read(runId)).toMatchObject({ state: 'succeeded', attempt: 1 })
      expect(await store.read(nextRunId)).toMatchObject({ state: 'pending', attempt: 0 })
      expect(drained).toBe(false)
      expect(events.some((event) => event.type === 'drained')).toBe(false)

      phases.release('dispose')
      await draining
      expect(drained).toBe(true)
      expect(supervisor.live().state).toBe('stopped')
      expect(events.filter((event) => event.type === 'drained')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'degraded')).toEqual([])
      expect(workerCreations).toBe(1)
      expect(await store.read(nextRunId)).toMatchObject({ state: 'pending', attempt: 0 })
    } catch (error) {
      failures.push(error)
    } finally {
      for (const cleanup of [
        () => phases.release('init'),
        () => phases.release('collect'),
        () => phases.release('dispose'),
        () => supervisor?.stop(1_000),
        () => phases.close(),
        () => database.dispose(),
        () => removeClosedWorkerHome(appHome),
      ]) {
        try {
          await cleanup()
        } catch (error) {
          failures.push(error)
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `cold actual Worker drain failed: ${failures.map(String).join('; ')}; events=${JSON.stringify(events)}`,
        {
          cause:
            failures.length === 1
              ? failures[0]
              : new AggregateError(failures, 'cold actual Worker drain and cleanup failed'),
        },
      )
    }
  }, 40_000)
})
