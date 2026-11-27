// Development reloads use the real host drain application: no overlapping
// generations, no repeated preparation, and no retained native signal handlers.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDevelopmentDaemonState,
  developmentListenPort,
  portIsFree,
  reloadDevelopmentDaemon,
} from '../src/bootstrap/developmentReload'
import type { DevelopmentOverlay } from '../src/bootstrap/developmentReload'
import { runDaemonHostApplication } from '../src/modules/system-operations/application/daemonHostApplication'
import type { DaemonHostLifecyclePort } from '../src/modules/system-operations/application/ports/daemonHostLifecycle'
import { createNativeDaemonHostLifecycle } from '../src/modules/system-operations/composition/daemonHostLifecycle'

/** `portOf` is where each generation says it listens; every start records the port it was told. */
function fixture(portOf: (generation: number) => number = () => 1) {
  const events: string[] = []
  let starts = 0
  const preparations: Array<DevelopmentOverlay['developmentIntegrity']> = []
  const toldPorts: Array<number | undefined> = []
  const drain = Promise.withResolvers<void>()
  const draining = Promise.withResolvers<void>()
  const createHost = (): DaemonHostLifecyclePort => ({
    readCurrent: () => null,
    publishReady() {
      events.push('ready')
    },
    withdrawReady() {
      events.push('withdraw')
    },
    subscribeShutdown() {
      return {
        close() {
          events.push('control-close')
        },
      }
    },
    announceReady() {},
    terminate(): never {
      throw new Error('source reload must retain the process')
    },
  })
  const start = async (options: DevelopmentOverlay) => {
    const generation = ++starts
    events.push(`start-${generation}`)
    preparations.push(options.developmentIntegrity)
    toldPorts.push(options.listenPort)
    return await runDaemonHostApplication({
      host: options.daemonHost!,
      databaseProvider: 'sqlite',
      readyInfo: () => ({
        host: '127.0.0.1',
        port: portOf(generation),
        url: 'local',
        startedAt: 'now',
      }),
      readBootstrapRequired: () => false,
      readyBrowserUrl: () => 'local',
      stopListener() {
        events.push(`listener-stop-${generation}`)
      },
      async stopApplication() {
        events.push(`drain-${generation}`)
        draining.resolve()
        await drain.promise
        events.push(`application-stop-${generation}`)
      },
      releaseAuthority() {
        events.push(`release-${generation}`)
      },
      releaseAuthorityOnExit() {},
      describeFailure: String,
      log: { info() {}, warn() {} },
    })
  }
  return { events, preparations, toldPorts, drain, draining, start, createHost }
}

test('replacement waits for listener, background application, control and authority cleanup', async () => {
  const f = fixture()
  const state = createDevelopmentDaemonState()
  await reloadDevelopmentDaemon(state, f.start, f.createHost)
  const reload = reloadDevelopmentDaemon(state, f.start, f.createHost)
  await f.draining.promise
  expect(f.events).not.toContain('start-2')
  f.drain.resolve()
  await reload
  expect(f.events.indexOf('start-2')).toBeGreaterThan(f.events.indexOf('release-1'))
  expect(f.events.indexOf('control-close')).toBeGreaterThan(f.events.indexOf('application-stop-1'))
  expect(f.preparations).toHaveLength(2)
  expect(f.preparations[0]).toBe(f.preparations[1])
  await state.current!.stop()
})

test('rapid saves while the old application drains coalesce into one replacement', async () => {
  const f = fixture()
  const state = createDevelopmentDaemonState()
  await reloadDevelopmentDaemon(state, f.start, f.createHost)
  const first = reloadDevelopmentDaemon(state, f.start, f.createHost)
  await f.draining.promise
  const second = reloadDevelopmentDaemon(state, f.start, f.createHost)
  const third = reloadDevelopmentDaemon(state, f.start, f.createHost)
  f.drain.resolve()
  await Promise.all([first, second, third])
  expect(state.revision).toBe(4)
  expect(f.events.filter((event) => event.startsWith('start-'))).toEqual(['start-1', 'start-2'])
  expect(f.events.filter((event) => event === 'release-1')).toHaveLength(1)
  await state.current!.stop()
})

test('a failed start cannot leave reusable integrity preparation behind', async () => {
  const f = fixture()
  f.drain.resolve()
  const state = createDevelopmentDaemonState()
  const failed = new Error('database preparation failed')
  await expect(
    reloadDevelopmentDaemon(
      state,
      async (options) => {
        options.developmentIntegrity!.validatedDatabase = 'incomplete'
        throw failed
      },
      f.createHost,
    ),
  ).rejects.toBe(failed)
  expect(state.integrity.validatedDatabase).toBeUndefined()
  expect(state.current).toBeUndefined()
  await reloadDevelopmentDaemon(state, f.start, f.createHost)
  await state.current!.stop()
})

test('closing native host control removes its SIGINT, SIGTERM and exit subscriptions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-dev-signals-'))
  const signals = ['SIGINT', 'SIGTERM', 'exit'] as const
  const before = signals.map((signal) => process.listenerCount(signal))
  const host = createNativeDaemonHostLifecycle({
    infoPath: join(root, '.daemon.info'),
    controlPath: join(root, '.control'),
    pid: process.pid,
    devWatch: true,
  })
  const control = await host.subscribeShutdown({
    onShutdown() {},
    onExit() {},
    onFailure(error) {
      throw error
    },
  })
  try {
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(
      before.map((count) => count + 1),
    )
    await control.close()
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before)
  } finally {
    await control.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// Regression (2026-11-26, `bun run dev` on a real installation): every source reload moved the dev
// daemon to a new ephemeral port. Vite resolves its `/api` proxy from `.daemon.info` once, when it
// starts, so after the first backend save every request through the dev server answered 500
// (`connect ECONNREFUSED` to the port of generation 1). A reload now listens where the previous
// generation did; dev-reload-cli.test.ts shows the same through the real `--hot` process.
test('a replacement is told where the previous generation listened; the first one is told nothing', async () => {
  // Each generation reports a port of its own, as if the one it was told had been taken.
  const f = fixture((generation) => 41_000 + generation)
  f.drain.resolve()
  const state = createDevelopmentDaemonState()
  await reloadDevelopmentDaemon(state, f.start, f.createHost)
  await reloadDevelopmentDaemon(state, f.start, f.createHost)
  await reloadDevelopmentDaemon(state, f.start, f.createHost)
  expect(f.toldPorts).toEqual([undefined, 41_001, 41_002])
  expect(state.listenPort).toBe(41_003)
  await state.current!.stop()
})

test('a start that fails does not forget the port: the next one still asks for it', async () => {
  const f = fixture(() => 41_001)
  f.drain.resolve()
  const state = createDevelopmentDaemonState()
  await reloadDevelopmentDaemon(state, f.start, f.createHost)
  const broken = new Error('a half-written source file')
  const told: Array<number | undefined> = []
  await expect(
    reloadDevelopmentDaemon(
      state,
      async (options) => {
        told.push(options.listenPort)
        throw broken
      },
      f.createHost,
    ),
  ).rejects.toBe(broken)
  // The failed generation was asked for the port too, and failing did not clear it.
  expect(told).toEqual([41_001])
  await reloadDevelopmentDaemon(state, f.start, f.createHost)
  expect(f.toldPorts).toEqual([undefined, 41_001])
  await state.current!.stop()
})

test('a configured port wins; with none, a reload keeps its previous port while that is free', () => {
  const unprobed = () => {
    throw new Error('this port must not be probed')
  }
  // Somebody chose the port: it is bound as is, in development too.
  expect(developmentListenPort({ configured: 7456, previous: 41_001, isFree: unprobed })).toBe(7456)
  // An ordinary start, and the first generation of a development session.
  expect(developmentListenPort({ configured: 0, previous: undefined, isFree: unprobed })).toBe(0)
  expect(developmentListenPort({ configured: 0, previous: 41_001, isFree: () => true })).toBe(
    41_001,
  )
  // Taken since: any free port still starts the daemon.
  expect(developmentListenPort({ configured: 0, previous: 41_001, isFree: () => false })).toBe(0)
})

test('a port somebody listens on is not free; once released it is, and can be bound at once', () => {
  const serve = (port: number) =>
    Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('ok') })
  const other = serve(0)
  const port = other.port!
  try {
    expect(portIsFree('127.0.0.1', port)).toBe(false)
  } finally {
    void other.stop(true)
  }
  // What a reload does: the previous generation has stopped, the check passes, the bind follows.
  expect(portIsFree('127.0.0.1', port)).toBe(true)
  const mine = serve(port)
  try {
    expect(mine.port).toBe(port)
  } finally {
    void mine.stop(true)
  }
})
