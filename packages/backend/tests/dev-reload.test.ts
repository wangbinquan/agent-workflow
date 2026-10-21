// Development reloads use the real host drain application: no overlapping
// generations, no repeated preparation, and no retained native signal handlers.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDevelopmentDaemonState,
  reloadDevelopmentDaemon,
} from '../src/bootstrap/developmentReload'
import type { StartOptions } from '../src/bootstrap/daemonStart'
import { runDaemonHostApplication } from '../src/modules/system-operations/application/daemonHostApplication'
import type { DaemonHostLifecyclePort } from '../src/modules/system-operations/application/ports/daemonHostLifecycle'
import { selectDaemonHostLifecycle } from '../src/modules/system-operations/composition/daemonHostLifecycle'

function fixture() {
  const events: string[] = []
  let starts = 0
  const preparations: Array<StartOptions['developmentIntegrity']> = []
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
  const start = async (options: StartOptions) => {
    const generation = ++starts
    events.push(`start-${generation}`)
    preparations.push(options.developmentIntegrity)
    return await runDaemonHostApplication({
      host: options.daemonHost!,
      databaseProvider: 'sqlite',
      readyInfo: () => ({ host: '127.0.0.1', port: 1, url: 'local', startedAt: 'now' }),
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
  return { events, preparations, drain, draining, start, createHost }
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
  const host = selectDaemonHostLifecycle(undefined, {
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
