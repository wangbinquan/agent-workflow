import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { MaintenanceWorkerEvent } from '@/platform/background/maintenanceProtocol'
import {
  startMaintenanceWorkerSupervisor,
  type MaintenanceWorkerSupervisor,
} from '@/platform/background/maintenanceWorkerSupervisor'
import { createMaintenanceRunStore } from '@/platform/persistence/maintenanceRunStore'
import { describeEachProvider } from './helpers/eachProvider'
import { openProviderMaintenanceWorkerDatabase } from './helpers/providerMaintenanceWorker'
import { MIGRATIONS } from './migration-freeze'

const effectsModule = new URL(
  './fixtures/rfc370-maintenance-worker-channel-effects.mjs',
  import.meta.url,
).href

interface Phase {
  readonly type: string
  readonly instanceRef: string
}

function phaseChannel() {
  const name = `rfc370-effects-${randomUUID()}`
  const channel = new BroadcastChannel(name)
  const received: Phase[] = []
  const pending = new Map<string, (phase: Phase) => void>()
  const observe = (phase: Phase) => {
    const resolvePhase = pending.get(phase.type)
    if (resolvePhase) {
      pending.delete(phase.type)
      resolvePhase(phase)
    } else received.push(phase)
  }
  channel.onmessage = (event) => observe(event.data as Phase)
  return {
    name,
    observe,
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
            reject(new Error(`worker-phase-timeout:${type}`))
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

function scenarioFailure(error: unknown, events: readonly MaintenanceWorkerEvent[]): Error {
  const observed = events.filter((event) =>
    ['ready', 'active', 'completed', 'degraded', 'drained'].includes(event.type),
  )
  return new Error(
    `selected Worker scenario failed: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(observed)}`,
    { cause: error },
  )
}

function terminalReceipt() {
  let resolveReceipt!: (event: Extract<MaintenanceWorkerEvent, { type: 'completed' }>) => void
  const promise = new Promise<Extract<MaintenanceWorkerEvent, { type: 'completed' }>>((resolve) => {
    resolveReceipt = resolve
  })
  return { promise, resolve: resolveReceipt }
}

describeEachProvider('RFC-370 actual selected maintenance Worker', (harness) => {
  test('fault drain followed by pause sends two real frames and waits for selected release', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc370-worker-double-drain-'))
    const database = openProviderMaintenanceWorkerDatabase(harness, appHome)
    const phases = phaseChannel()
    const events: MaintenanceWorkerEvent[] = []
    let supervisor: MaintenanceWorkerSupervisor | undefined
    let failed: { readonly error: unknown } | undefined
    try {
      supervisor = startMaintenanceWorkerSupervisor({
        appHome,
        databaseInit: database.databaseInit,
        effectsBootstrap: {
          moduleSpecifier: effectsModule,
          exportName: 'createEffects',
          configurationJson: JSON.stringify({ channelName: phases.name, holdDispose: true }),
          capabilities: ['pluginGenerationGc'],
        },
        onEvent(event) {
          events.push(event)
          if (event.type === 'ready')
            phases.observe({ type: 'worker-ready', instanceRef: 'supervisor' })
        },
      })
      await phases.wait('factory-entered')
      await phases.wait('worker-ready')
      phases.release('fault')
      await phases.wait('drain-received')
      await phases.wait('dispose-entered')
      let paused = false
      const pausing = supervisor.pause(15_000).then(() => {
        paused = true
      })
      await phases.wait('drain-received')
      expect(paused).toBe(false)
      expect(events.some((event) => event.type === 'drained')).toBe(false)
      phases.release('dispose')
      await pausing
      expect(paused).toBe(true)
      expect(supervisor.live().state).toBe('stopped')
    } catch (error) {
      failed = { error }
    } finally {
      phases.release('dispose')
      await supervisor?.stop(1_000)
      phases.close()
      await database.dispose()
      rmSync(appHome, { recursive: true, force: true })
    }
    if (failed !== undefined) throw scenarioFailure(failed.error, events)
  }, 40_000)

  for (const collectFailure of [false, true]) {
    test(`settles selected GC ${collectFailure ? 'failure' : 'success'} and waits for release ACK`, async () => {
      const appHome = mkdtempSync(join(tmpdir(), 'rfc370-real-worker-'))
      const database = openProviderMaintenanceWorkerDatabase(harness, appHome)
      const store = createMaintenanceRunStore(database.db)
      const phases = phaseChannel()
      const runId = randomUUID()
      const events: MaintenanceWorkerEvent[] = []
      const completed = terminalReceipt()
      let supervisor: MaintenanceWorkerSupervisor | undefined
      let failed: { readonly error: unknown } | undefined
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
        supervisor = startMaintenanceWorkerSupervisor({
          appHome,
          databaseInit: database.databaseInit,
          effectsBootstrap: {
            moduleSpecifier: effectsModule,
            exportName: 'createEffects',
            configurationJson: JSON.stringify({
              channelName: phases.name,
              holdInit: true,
              holdCollect: true,
              holdDispose: true,
              collectFailure,
            }),
            capabilities: ['pluginGenerationGc'],
          },
          onEvent(event) {
            events.push(event)
            if (event.type === 'completed' && event.runId === runId) completed.resolve(event)
          },
        })
        const factory = await phases.wait('factory-entered')
        expect(supervisor.live().state).toBe('starting')
        expect(await store.read(runId)).toMatchObject({ state: 'pending', attempt: 0 })
        phases.release('init')
        const collecting = await phases.wait('gc-collect-entered')
        expect(collecting.instanceRef).toBe(factory.instanceRef)
        expect(await store.read(runId)).toMatchObject({ state: 'running', attempt: 1 })
        expect(events.some((event) => event.type === 'completed')).toBe(false)
        let drained = false
        const drain = supervisor.drain(15_000).then(() => {
          drained = true
        })
        await phases.wait('drain-received')
        phases.release('collect')
        const releasing = await phases.wait('dispose-entered')
        expect(releasing.instanceRef).toBe(factory.instanceRef)
        const result = await completed.promise
        expect(result.outcome).toBe(collectFailure ? 'failed' : 'succeeded')
        if (collectFailure) expect(result.errorMessage).toBe('selected-gc-failure')
        else expect(result.counters.removed).toBe(1)
        expect(await store.read(runId)).toMatchObject({
          state: collectFailure ? 'failed' : 'succeeded',
          attempt: 1,
        })
        expect(drained).toBe(false)
        expect(events.some((event) => event.type === 'drained')).toBe(false)
        phases.release('dispose')
        await drain
        expect(events.some((event) => event.type === 'drained')).toBe(true)
        expect(supervisor.live().state).toBe('stopped')
        expect(events.filter((event) => event.type === 'degraded')).toEqual([])
      } catch (error) {
        failed = { error }
      } finally {
        phases.release('init')
        phases.release('collect')
        phases.release('dispose')
        await supervisor?.stop(1_000)
        phases.close()
        await database.dispose()
        rmSync(appHome, { recursive: true, force: true })
      }
      if (failed !== undefined) throw scenarioFailure(failed.error, events)
    }, 40_000)
  }

  test('an actual drain during factory ACK never admits the queued job', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc370-real-boot-drain-'))
    const database = openProviderMaintenanceWorkerDatabase(harness, appHome)
    const store = createMaintenanceRunStore(database.db)
    const phases = phaseChannel()
    const events: MaintenanceWorkerEvent[] = []
    const runId = randomUUID()
    let supervisor: MaintenanceWorkerSupervisor | undefined
    let failed: { readonly error: unknown } | undefined
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
      supervisor = startMaintenanceWorkerSupervisor({
        appHome,
        databaseInit: database.databaseInit,
        effectsBootstrap: {
          moduleSpecifier: effectsModule,
          exportName: 'createEffects',
          configurationJson: JSON.stringify({
            channelName: phases.name,
            holdInit: true,
            holdDispose: true,
          }),
          capabilities: ['pluginGenerationGc'],
        },
        onEvent: (event) => events.push(event),
      })
      await phases.wait('factory-entered')
      const paused = supervisor.pause(15_000)
      await phases.wait('drain-received')
      phases.release('init')
      await phases.wait('dispose-entered')
      expect(
        events.some(
          (event) => event.type === 'ready' || event.type === 'active' || event.type === 'drained',
        ),
      ).toBe(false)
      expect(await store.read(runId)).toMatchObject({ state: 'pending', attempt: 0 })
      phases.release('dispose')
      await paused
      expect(events.filter((event) => event.type === 'drained')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'degraded')).toEqual([])
    } catch (error) {
      failed = { error }
    } finally {
      phases.release('init')
      phases.release('dispose')
      await supervisor?.stop(1_000)
      phases.close()
      await database.dispose()
      rmSync(appHome, { recursive: true, force: true })
    }
    if (failed !== undefined) throw scenarioFailure(failed.error, events)
  }, 40_000)
})

test('a compiled standalone entry loads an external assembly module through the original Worker entry', async () => {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc370-compiled-worker-'))
  const backendSrc = resolve(import.meta.dir, '../src')
  const virtualMain = join(backendSrc, 'rfc370CompiledWorkerProbe.ts')
  const outfile = join(appHome, `worker-probe${process.platform === 'win32' ? '.exe' : ''}`)
  try {
    const built = await Bun.build({
      entrypoints: [virtualMain, join(backendSrc, 'platform/background/maintenanceWorker.ts')],
      target: 'bun',
      define: { AW_COMPILED_BUILD: 'true' },
      compile: { outfile },
      files: {
        [virtualMain]: readFileSync(
          new URL('./fixtures/rfc370-compiled-maintenance-effects-probe.ts', import.meta.url),
          'utf8',
        ),
      },
    })
    expect(built.success, built.logs.map(String).join('\n')).toBe(true)
    const child = Bun.spawn(
      [
        outfile,
        JSON.stringify({
          appHome,
          dbPath: join(appHome, 'db.sqlite'),
          migrationsFolder: MIGRATIONS,
          moduleSpecifier: effectsModule,
          channelName: `rfc370-compiled-${randomUUID()}`,
        }),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode, stderr).toBe(0)
    const receipt = stdout.split('\n').find((line) => line.startsWith('RFC370_COMPILED_WORKER:'))
    expect(receipt).toBeDefined()
    expect(JSON.parse(receipt!.slice('RFC370_COMPILED_WORKER:'.length))).toMatchObject({
      outcome: 'succeeded',
      removed: 1,
    })
  } finally {
    rmSync(appHome, { recursive: true, force: true })
  }
}, 90_000)
