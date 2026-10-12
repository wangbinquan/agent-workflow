import { spawnSync } from 'node:child_process'
import { expect, test } from 'bun:test'

import { MAINTENANCE_CATALOG_DIGEST } from '@/platform/background/maintenanceCatalog'
import { MAINTENANCE_PROTOCOL_VERSION } from '@/platform/background/maintenanceProtocol'
import { createColdMaintenanceWorkerSupervisor } from '@/platform/background/maintenanceWorkerSupervisor'

class ManualWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => unknown) | null = null
  private onclose: ((event: { readonly code?: number }) => void) | null = null
  readonly messages: unknown[] = []
  terminated = 0
  acknowledgeDrainSynchronously = false

  addEventListener(_type: 'close', listener: (event: { readonly code?: number }) => void) {
    this.onclose = listener
  }
  postMessage(message: unknown) {
    this.messages.push(message)
    if (
      this.acknowledgeDrainSynchronously &&
      (message as { readonly type?: string }).type === 'drain'
    )
      this.drained()
  }
  terminate() {
    this.terminated += 1
  }
  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent<unknown>)
  }
  ready(catalogDigest = MAINTENANCE_CATALOG_DIGEST) {
    this.emit({ type: 'ready', version: MAINTENANCE_PROTOCOL_VERSION, catalogDigest, at: 100 })
  }
  drained() {
    this.emit({ type: 'drained', version: MAINTENANCE_PROTOCOL_VERSION, at: 200 })
  }
  close() {
    this.onclose?.({ code: 1 })
  }
}

function harness(options: { readonly onCreate?: (worker: ManualWorker) => void } = {}) {
  const workers: ManualWorker[] = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const supervisor = createColdMaintenanceWorkerSupervisor({
    appHome: '/cold-maintenance-supervisor',
    databaseInit: {
      dbPath: '/cold-maintenance-supervisor/db.sqlite',
      migrationsFolder: '/cold-maintenance-supervisor/migrations',
      sqlite: { synchronous: 'NORMAL', pageCacheMib: 8, mmapMib: 0, busyTimeoutMs: 50 },
    },
    workerFactory() {
      const worker = new ManualWorker()
      workers.push(worker)
      options.onCreate?.(worker)
      return worker
    },
    setTimer(fn, ms) {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer(value) {
      ;(value as { cleared: boolean }).cleared = true
    },
  })
  return { supervisor, workers, timers }
}

function observe<T>(promise: Promise<T>) {
  const outcome: { settled: boolean; error?: unknown } = { settled: false }
  void promise.then(
    () => {
      outcome.settled = true
    },
    (error: unknown) => {
      outcome.settled = true
      outcome.error = error
    },
  )
  return outcome
}

async function microtasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

test('cold construction, queries, wake and unstarted pause/resume/stop create no Worker or timer', async () => {
  const { supervisor, workers, timers } = harness()
  expect(supervisor.live()).toEqual({
    state: 'stopped',
    lastHeartbeatAt: null,
    error: null,
    active: null,
  })
  supervisor.wake()
  await supervisor.pause()
  await supervisor.resume()
  supervisor.quiesce()
  await supervisor.awaitDrained()
  await supervisor.stop()
  expect(workers).toEqual([])
  expect(timers).toEqual([])
  await expect(supervisor.start()).rejects.toThrow('supervisor stopped')
})

test('start shares its pending receipt and waits for the actual catalog handshake', async () => {
  const { supervisor, workers } = harness()
  const starting = supervisor.start()
  const outcome = observe(starting)
  expect(supervisor.start()).toBe(starting)
  await microtasks()
  expect(workers).toHaveLength(1)
  expect(workers[0]!.messages).toHaveLength(1)
  expect(workers[0]!.messages[0]).toMatchObject({
    type: 'init',
    dbPath: '/cold-maintenance-supervisor/db.sqlite',
    catalogDigest: MAINTENANCE_CATALOG_DIGEST,
  })
  expect(outcome.settled).toBe(false)
  workers[0]!.ready()
  await starting
  expect(supervisor.live().state).toBe('ready')
  expect(workers[0]!.messages.at(-1)).toMatchObject({ type: 'wake' })
  supervisor.quiesce()
  workers[0]!.drained()
  await supervisor.awaitDrained()
  await supervisor.stop()
})

test('loss before factory creation closes admission before any Worker exists', async () => {
  const { supervisor, workers, timers } = harness()
  const starting = supervisor.start()
  observe(starting)
  supervisor.quiesce()
  await expect(starting).rejects.toThrow('start quiesced')
  await supervisor.awaitDrained()
  expect(workers).toEqual([])
  expect(timers).toEqual([])
  await supervisor.stop()
})

test('loss while starting retains the same Worker and rejects readiness before its actual drain', async () => {
  const { supervisor, workers } = harness()
  const starting = supervisor.start()
  observe(starting)
  await microtasks()
  const worker = workers[0]!
  supervisor.quiesce()
  await expect(starting).rejects.toThrow('quiesced before ready')
  const draining = supervisor.awaitDrained()
  const outcome = observe(draining)
  worker.ready()
  supervisor.wake()
  await microtasks()
  expect(worker.messages.filter((m) => (m as { type: string }).type === 'wake')).toEqual([])
  expect(outcome.settled).toBe(false)
  expect(worker.terminated).toBe(0)
  worker.drained()
  await draining
  expect(worker.terminated).toBe(1)
  await supervisor.stop()
})

test('loss drain timeout retains the Worker and its receipt, and a late actual ACK permits retry', async () => {
  const { supervisor, workers, timers } = harness()
  const starting = supervisor.start()
  await microtasks()
  const worker = workers[0]!
  worker.ready()
  await starting
  supervisor.quiesce()
  const draining = supervisor.awaitDrained(17)
  observe(draining)
  timers.find((timer) => timer.ms === 17 && !timer.cleared)!.fn()
  await expect(draining).rejects.toThrow('actual drain timed out')
  supervisor.wake()
  expect(worker.terminated).toBe(0)
  expect(workers).toHaveLength(1)
  const nextStart = supervisor.start()
  observe(nextStart)
  await microtasks()
  expect(workers).toHaveLength(1)
  worker.drained()
  await supervisor.awaitDrained()
  await microtasks()
  expect(workers).toHaveLength(2)
  workers[1]!.ready()
  await nextStart
  supervisor.quiesce()
  workers[1]!.drained()
  await supervisor.awaitDrained()
  await supervisor.stop()
})

test('a bare Worker close does not certify actual drain or admit a replacement', async () => {
  const { supervisor, workers, timers } = harness()
  const starting = supervisor.start()
  await microtasks()
  workers[0]!.ready()
  await starting
  supervisor.quiesce()
  workers[0]!.close()
  const draining = supervisor.awaitDrained(19)
  observe(draining)
  timers.find((timer) => timer.ms === 19 && !timer.cleared)!.fn()
  await expect(draining).rejects.toThrow('actual drain timed out')
  const restarting = supervisor.start()
  observe(restarting)
  await microtasks()
  expect(workers).toHaveLength(1)
  timers
    .slice()
    .reverse()
    .find((timer) => timer.ms === 10_000 && !timer.cleared)!
    .fn()
  await expect(restarting).rejects.toThrow('actual drain timed out')
  await supervisor.stop()
})

test('invalid catalog handshake fails start and waits for the same Worker actual drain', async () => {
  const { supervisor, workers, timers } = harness()
  const starting = supervisor.start()
  observe(starting)
  await microtasks()
  workers[0]!.ready('0'.repeat(64))
  await expect(starting).rejects.toThrow('catalog digest mismatch')
  expect(workers[0]!.messages.at(-1)).toMatchObject({ type: 'drain' })
  expect(workers[0]!.terminated).toBe(0)
  expect(timers.filter((timer) => !timer.cleared)).toEqual([])
  workers[0]!.drained()
  await supervisor.awaitDrained()
  await supervisor.stop()
})

test('normal pause keeps its force timeout but that completion is not an actual drain receipt', async () => {
  const { supervisor, workers, timers } = harness()
  const starting = supervisor.start()
  await microtasks()
  workers[0]!.ready()
  await starting
  const pausing = supervisor.pause(23)
  timers.find((timer) => timer.ms === 23 && !timer.cleared)!.fn()
  await pausing
  expect(workers[0]!.terminated).toBe(1)
  const actual = supervisor.awaitDrained(29)
  observe(actual)
  timers.find((timer) => timer.ms === 29 && !timer.cleared)!.fn()
  await expect(actual).rejects.toThrow('actual drain timed out')
  expect(workers).toHaveLength(1)
  await supervisor.stop()
})

test('a queued normal-pause timeout cannot terminate the next acknowledged Worker generation', async () => {
  const { supervisor, workers, timers } = harness()
  const starting = supervisor.start()
  await microtasks()
  workers[0]!.ready()
  await starting
  workers[0]!.acknowledgeDrainSynchronously = true
  await supervisor.pause(31)
  const oldTimer = timers.find((timer) => timer.ms === 31)!
  expect(oldTimer.cleared).toBe(true)
  const resuming = supervisor.resume()
  await microtasks()
  expect(workers).toHaveLength(2)
  workers[1]!.ready()
  await resuming
  oldTimer.fn()
  expect(workers[1]!.terminated).toBe(0)
  expect(supervisor.live().state).toBe('ready')
  supervisor.quiesce()
  workers[1]!.drained()
  await supervisor.awaitDrained()
  await supervisor.stop()
})

// SOURCE-R1 P2-002: rejecting a restart wait must keep the old ready Worker
// fenced. Its remembered ready state cannot replace its missing drained ACK.
test('restart wait rejection keeps the old Worker fenced through another start and wake', async () => {
  const { supervisor, workers, timers } = harness()
  const starting = supervisor.start()
  await microtasks()
  const old = workers[0]!
  old.ready()
  await starting
  const wakesBeforeLoss = old.messages.filter((m) => (m as { type: string }).type === 'wake').length
  supervisor.quiesce()
  for (let i = 0; i < 2; i += 1) {
    const restarting = supervisor.start()
    const outcome = observe(restarting)
    expect(supervisor.start()).toBe(restarting)
    await microtasks()
    supervisor.wake()
    expect(outcome.settled).toBe(false)
    expect(workers).toHaveLength(1)
    expect(old.messages.filter((m) => (m as { type: string }).type === 'wake')).toHaveLength(
      wakesBeforeLoss,
    )
    timers
      .slice()
      .reverse()
      .find((timer) => timer.ms === 10_000 && !timer.cleared)!
      .fn()
    await expect(restarting).rejects.toThrow('actual drain timed out')
    supervisor.wake()
    expect(old.messages.filter((m) => (m as { type: string }).type === 'wake')).toHaveLength(
      wakesBeforeLoss,
    )
    expect(old.terminated).toBe(0)
  }
  expect(old.messages.filter((m) => (m as { type: string }).type === 'drain')).toHaveLength(1)
  old.drained()
  await supervisor.awaitDrained()
  const next = supervisor.start()
  await microtasks()
  expect(workers).toHaveLength(2)
  const outcome = observe(next)
  expect(outcome.settled).toBe(false)
  workers[1]!.ready()
  await next
  supervisor.quiesce()
  workers[1]!.drained()
  await supervisor.awaitDrained()
  await supervisor.stop()
})

test('normal pause while restart waits for an old ACK also fences deferred Worker creation', async () => {
  const { supervisor, workers } = harness()
  const starting = supervisor.start()
  await microtasks()
  workers[0]!.ready()
  await starting
  supervisor.quiesce()
  const restarting = supervisor.start()
  observe(restarting)
  await microtasks()
  await supervisor.pause()
  workers[0]!.drained()
  await expect(restarting).rejects.toThrow('start quiesced')
  expect(workers).toHaveLength(1)
  const resuming = supervisor.resume()
  await microtasks()
  expect(workers).toHaveLength(2)
  workers[1]!.ready()
  await resuming
  supervisor.quiesce()
  workers[1]!.drained()
  await supervisor.awaitDrained()
  await supervisor.stop()
})

// SOURCE-R2 P2-004: quiesce before factory return must fence the new receipt
// after it is installed, rather than waiting forever for fenced readiness.
test('factory reentrant quiesce drains the returned Worker before waiting for readiness', async () => {
  const h: ReturnType<typeof harness> = harness({
    onCreate() {
      if (h.workers.length === 1) h.supervisor.quiesce()
    },
  })
  const { supervisor, workers, timers } = h
  const starting = supervisor.start()
  observe(starting)
  await expect(starting).rejects.toThrow('start quiesced')
  expect(workers).toHaveLength(1)
  const original = workers[0]!
  expect(original.messages.map((m) => (m as { type: string }).type)).toEqual(['init', 'drain'])
  expect(original.terminated).toBe(0)
  expect(timers.filter((timer) => !timer.cleared)).toEqual([])
  const draining = supervisor.awaitDrained(17)
  observe(draining)
  timers.find((timer) => timer.ms === 17 && !timer.cleared)!.fn()
  await expect(draining).rejects.toThrow('actual drain timed out')
  const next = supervisor.start()
  const outcome = observe(next)
  await microtasks()
  original.ready()
  supervisor.wake()
  expect(workers).toHaveLength(1)
  expect(outcome.settled).toBe(false)
  expect(original.terminated).toBe(0)
  expect(original.messages.filter((m) => (m as { type: string }).type === 'wake')).toEqual([])
  original.drained()
  await microtasks()
  expect(workers).toHaveLength(2)
  workers[1]!.ready()
  await next
  supervisor.quiesce()
  workers[1]!.drained()
  await supervisor.awaitDrained()
  await supervisor.stop()
})

test('factory reentrant normal pause fences the installed Worker and explicit resume awaits a fresh handshake', async () => {
  const h: ReturnType<typeof harness> = harness({
    onCreate() {
      if (h.workers.length === 1) void h.supervisor.pause()
    },
  })
  const { supervisor, workers } = h
  const starting = supervisor.start()
  observe(starting)
  await expect(starting).rejects.toThrow('start quiesced')
  const original = workers[0]!
  expect(original.messages.map((m) => (m as { type: string }).type)).toEqual(['init', 'drain'])
  expect(original.terminated).toBe(0)
  original.drained()
  const resuming = supervisor.resume()
  const outcome = observe(resuming)
  await microtasks()
  expect(workers).toHaveLength(2)
  expect(outcome.settled).toBe(false)
  workers[1]!.ready()
  await resuming
  supervisor.quiesce()
  workers[1]!.drained()
  await supervisor.awaitDrained()
  await supervisor.stop()
})

test('loss during ordinary resume awaiting the pause ACK prevents deferred Worker creation', async () => {
  const { supervisor, workers } = harness()
  const starting = supervisor.start()
  await microtasks()
  const original = workers[0]!
  original.ready()
  await starting
  const pausing = supervisor.pause()
  const resuming = supervisor.resume()
  observe(resuming)
  supervisor.quiesce()
  original.drained()
  await pausing
  await expect(resuming).rejects.toThrow('start quiesced')
  expect(workers).toHaveLength(1)
  expect(original.terminated).toBe(1)
  await supervisor.awaitDrained()
  await supervisor.stop()
})

test('actual drain propagates the same deadline cleanup error to its caller', async () => {
  const worker = new ManualWorker()
  const clearError = new Error('actual drain deadline cleanup failed')
  let drainTimer: unknown
  const supervisor = createColdMaintenanceWorkerSupervisor({
    appHome: '/cold-maintenance-supervisor',
    databaseInit: {
      dbPath: '/cold-maintenance-supervisor/db.sqlite',
      migrationsFolder: '/cold-maintenance-supervisor/migrations',
      sqlite: { synchronous: 'NORMAL', pageCacheMib: 8, mmapMib: 0, busyTimeoutMs: 50 },
    },
    workerFactory: () => worker,
    setTimer(fn, ms) {
      const timer = { fn, ms, cleared: false }
      if (ms === 17) drainTimer = timer
      return timer
    },
    clearTimer(value) {
      if (value === drainTimer) throw clearError
      ;(value as { cleared: boolean }).cleared = true
    },
  })
  const starting = supervisor.start()
  await microtasks()
  worker.ready()
  await starting
  supervisor.quiesce()
  const draining = supervisor.awaitDrained(17)
  worker.drained()
  await expect(draining).rejects.toBe(clearError)
  expect(worker.terminated).toBe(1)
  await supervisor.awaitDrained()
  await supervisor.stop()
})

test('the actual Worker drain deadline rejects in a fresh process after bare close without ACK', () => {
  const supervisorUrl = new URL(
    '../src/platform/background/maintenanceWorkerSupervisor.ts',
    import.meta.url,
  ).href
  const protocolUrl = new URL('../src/platform/background/maintenanceProtocol.ts', import.meta.url)
    .href
  const catalogUrl = new URL('../src/platform/background/maintenanceCatalog.ts', import.meta.url)
    .href
  const script = `
    import { createColdMaintenanceWorkerSupervisor } from ${JSON.stringify(supervisorUrl)};
    import { MAINTENANCE_PROTOCOL_VERSION } from ${JSON.stringify(protocolUrl)};
    import { MAINTENANCE_CATALOG_DIGEST } from ${JSON.stringify(catalogUrl)};
    class ManualWorker {
      onmessage = null;
      onerror = null;
      closeListener = null;
      addEventListener(_type, listener) { this.closeListener = listener; }
      postMessage(message) {
        if (message.type === 'init') queueMicrotask(() => this.onmessage?.({ data: {
          type: 'ready', version: MAINTENANCE_PROTOCOL_VERSION,
          catalogDigest: MAINTENANCE_CATALOG_DIGEST, at: 100,
        } }));
      }
      terminate() {}
      close() { this.closeListener?.({ code: 1 }); }
    }
    const worker = new ManualWorker();
    const supervisor = createColdMaintenanceWorkerSupervisor({
      appHome: '/cold-maintenance-supervisor',
      databaseInit: {
        dbPath: '/cold-maintenance-supervisor/db.sqlite',
        migrationsFolder: '/cold-maintenance-supervisor/migrations',
        sqlite: { synchronous: 'NORMAL', pageCacheMib: 8, mmapMib: 0, busyTimeoutMs: 50 },
      },
      workerFactory: () => worker,
    });
    await supervisor.start();
    supervisor.quiesce();
    worker.close();
    try {
      await supervisor.awaitDrained(17);
      throw new Error('actual Worker drain incorrectly resolved');
    } catch (error) {
      if (error?.message !== 'maintenance worker actual drain timed out') throw error;
      console.log('maintenance Worker drain deadline rejected');
    }
  `
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: import.meta.dir,
    encoding: 'utf8',
    timeout: 3_000,
    windowsHide: true,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.signal).toBeNull()
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe('maintenance Worker drain deadline rejected\n')
})
