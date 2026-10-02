// RFC-370 A1: exercise the real shared Bun listener with a selected host lifecycle.
// These fixtures run on hosted CI; the implementation session does not start AW.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveDaemon } from '../src/cli/start'
import {
  selectDaemonHostLifecycle,
  selectDaemonRuntimeQueries,
} from '../src/modules/system-operations/composition/daemonHostLifecycle'
import type {
  DaemonHostControl,
  DaemonHostLifecyclePort,
  DaemonHostShutdownCallbacks,
  DaemonReadiness,
} from '../src/modules/system-operations/application/ports/daemonHostLifecycle'
import type { DaemonRuntimeInfo } from '../src/modules/system-operations/public/types'
import type { Logger } from '../src/util/log'

function hostFixture(
  options: {
    holdSubscription?: boolean
    holdFinalWithdrawal?: boolean
    subscriptionFailure?: boolean
    publishFailure?: boolean
    withdrawFailure?: boolean
    stopFailure?: boolean
    closeFailure?: boolean
  } = {},
) {
  const events: string[] = []
  const warnings: string[] = []
  const subscribed = Promise.withResolvers<void>()
  const subscriptionAck = Promise.withResolvers<void>()
  const publishing = Promise.withResolvers<void>()
  const publishAck = Promise.withResolvers<void>()
  const announced = Promise.withResolvers<void>()
  const withdrawing = Promise.withResolvers<void>()
  const withdrawAck = Promise.withResolvers<void>()
  const finalWithdrawing = Promise.withResolvers<void>()
  const finalWithdrawAck = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>()
  const closeAck = Promise.withResolvers<void>()
  const terminated = Promise.withResolvers<void>()
  const lateWithdrawn = Promise.withResolvers<void>()
  let callbacks: DaemonHostShutdownCallbacks | undefined
  let current: DaemonRuntimeInfo | null = null
  let boundUrl = ''
  let browserUrl = ''
  let released = false
  let withdraws = 0
  const log: Logger = {
    debug() {},
    info(message, fields) {
      if (message === 'listening' && typeof fields?.url === 'string') boundUrl = fields.url
    },
    error() {},
    warn(message) {
      warnings.push(message)
    },
    child() {
      return log
    },
  }
  class Control implements DaemonHostControl {
    async close() {
      expect<DaemonHostControl>(this).toBe(control)
      events.push('control-close:enter')
      closing.resolve()
      await closeAck.promise
      if (options.closeFailure) throw new Error('host control close ACK lost')
      events.push('control-close:ack')
    }
  }
  const control: DaemonHostControl = Object.freeze(new Control())
  class Host implements DaemonHostLifecyclePort {
    get readCurrent() {
      expect<DaemonHostLifecyclePort>(this).toBe(host)
      return () => current
    }
    async publishReady(readiness: DaemonReadiness) {
      expect<DaemonHostLifecyclePort>(this).toBe(host)
      events.push('publish:enter')
      boundUrl = readiness.url
      expect(readiness.host).toBe('127.0.0.1')
      expect(readiness.port).toBeGreaterThan(0)
      expect(Number(new URL(readiness.url).port)).toBe(readiness.port)
      expect(Number.isFinite(Date.parse(readiness.startedAt))).toBe(true)
      publishing.resolve()
      await publishAck.promise
      if (options.publishFailure) throw new Error('host ready ACK lost')
      current = { pid: 818, ...readiness }
      events.push('publish:ack')
    }
    async withdrawReady() {
      expect<DaemonHostLifecyclePort>(this).toBe(host)
      events.push('withdraw:enter')
      withdrawing.resolve()
      await withdrawAck.promise
      if (withdraws === 1 && options.holdFinalWithdrawal) {
        finalWithdrawing.resolve()
        await finalWithdrawAck.promise
      }
      if (options.withdrawFailure) throw new Error('host withdraw ACK lost')
      current = null
      events.push('withdraw:ack')
      withdraws += 1
      if (withdraws === 2) lateWithdrawn.resolve()
    }
    async subscribeShutdown(input: DaemonHostShutdownCallbacks) {
      expect<DaemonHostLifecyclePort>(this).toBe(host)
      events.push('subscribe:enter')
      callbacks = input
      subscribed.resolve()
      if (options.holdSubscription) await subscriptionAck.promise
      if (options.subscriptionFailure) throw new Error('host control subscription failed')
      events.push('subscribe:ack')
      return control
    }
    announceReady(url: string) {
      expect<DaemonHostLifecyclePort>(this).toBe(host)
      events.push('announce')
      browserUrl = url
      announced.resolve()
    }
    terminate(code: number): Promise<never> {
      expect<DaemonHostLifecyclePort>(this).toBe(host)
      expect(code).toBe(0)
      events.push('terminate:0')
      terminated.resolve()
      return new Promise<never>(() => {})
    }
  }
  const host: DaemonHostLifecyclePort = Object.freeze(new Host())
  expect(Object.keys(host)).toEqual([])
  const start = (provider: 'sqlite' | 'postgresql') =>
    serveDaemon({
      bootstrap: {
        runBusinessRequest: async (_request, next) => next(),
        tryUpgrade: async () => false,
        fetch: async () => new Response('active'),
        websocketHandlers: { open() {}, message() {}, close() {} },
        async stop() {
          events.push('bootstrap-stop')
          await expect(fetch(boundUrl)).rejects.toThrow()
          if (options.stopFailure) throw new Error('provider close failed')
        },
      },
      authRuntime: {
        async isBootstrapRequired() {
          events.push('bootstrap-required')
          return false
        },
      },
      databaseProvider: provider,
      token: 'a'.repeat(64),
      bindHost: '127.0.0.1',
      bindPort: 0,
      lock: {
        pid: 818,
        path: 'unused-local-lock',
        release() {
          if (!released) {
            released = true
            events.push('lock-release')
          }
        },
      },
      daemonHost: host,
      log,
    })
  const requestShutdown = (reason = 'control-shutdown') => {
    if (!callbacks) throw new Error('host control has not subscribed')
    return Promise.resolve(callbacks.onShutdown(reason))
  }
  const cleanup = async () => {
    subscriptionAck.resolve()
    publishAck.resolve()
    withdrawAck.resolve()
    finalWithdrawAck.resolve()
    closeAck.resolve()
    if (callbacks && !released) {
      void requestShutdown('test-cleanup').catch((error) => {
        throw error
      })
      await terminated.promise
    }
  }
  return {
    host,
    start,
    events,
    warnings,
    subscribed,
    subscriptionAck,
    publishing,
    publishAck,
    announced,
    withdrawing,
    withdrawAck,
    finalWithdrawing,
    finalWithdrawAck,
    closing,
    closeAck,
    terminated,
    lateWithdrawn,
    requestShutdown,
    cleanup,
    url: () => boundUrl,
    browserUrl: () => browserUrl,
  }
}

for (const provider of ['sqlite', 'postgresql'] as const) {
  test(`${provider} shared listener waits for ready/withdraw/control ACKs in the original shutdown order`, async () => {
    const f = hostFixture()
    const failure = Promise.withResolvers<unknown>()
    void f.start(provider).catch(failure.resolve)
    try {
      await Promise.race([
        f.publishing.promise,
        failure.promise.then((error) => {
          throw error
        }),
      ])
      expect(f.events).toEqual(['subscribe:enter', 'subscribe:ack', 'publish:enter'])
      f.publishAck.resolve()
      await f.announced.promise
      expect(f.browserUrl().startsWith(f.url())).toBe(true)
      expect((await fetch(f.url())).status).toBe(200)
      void f.requestShutdown().catch(failure.resolve)
      await f.withdrawing.promise
      expect(f.events).not.toContain('bootstrap-stop')
      f.withdrawAck.resolve()
      await f.closing.promise
      expect(f.events).toContain('bootstrap-stop')
      expect(f.events).not.toContain('lock-release')
      f.closeAck.resolve()
      await f.terminated.promise
      expect(f.events).toEqual([
        'subscribe:enter',
        'subscribe:ack',
        'publish:enter',
        'publish:ack',
        'bootstrap-required',
        'announce',
        'withdraw:enter',
        'withdraw:ack',
        'bootstrap-stop',
        'control-close:enter',
        'control-close:ack',
        'lock-release',
        'terminate:0',
      ])
      await f.requestShutdown('SIGINT')
      expect(f.events.filter((event) => event === 'bootstrap-stop')).toHaveLength(1)
      expect(f.host.readCurrent()).toBeNull()
    } finally {
      await f.cleanup()
    }
  }, 20_000)

  test(`${provider} selected ready failure returns the same error before browser announcement`, async () => {
    const f = hostFixture({ publishFailure: true })
    const serving = f.start(provider)
    void serving.catch(() => {})
    try {
      await f.publishing.promise
      f.publishAck.resolve()
      await f.withdrawing.promise
      f.withdrawAck.resolve()
      await f.closing.promise
      f.closeAck.resolve()
      await expect(serving).rejects.toThrow('host ready ACK lost')
      expect(f.events).not.toContain('bootstrap-required')
      expect(f.events).not.toContain('announce')
    } finally {
      await f.cleanup()
    }
  }, 20_000)
}

test('shutdown during subscription ACK drains the listener and waits for the eventual same control handle', async () => {
  const f = hostFixture({ holdSubscription: true })
  void f.start('sqlite').catch(() => {})
  try {
    await f.subscribed.promise
    void f.requestShutdown('SIGTERM').catch(() => {})
    await f.withdrawing.promise
    f.withdrawAck.resolve()
    f.subscriptionAck.resolve()
    await f.closing.promise
    f.closeAck.resolve()
    await f.terminated.promise
    expect(f.events).toContain('control-close:ack')
    expect(f.events.filter((event) => event === 'terminate:0')).toHaveLength(1)
    expect(f.events).not.toContain('publish:enter')
    expect(f.events).not.toContain('announce')
  } finally {
    await f.cleanup()
  }
}, 20_000)

test('readiness withdrawal and provider close failures still complete host drain without another adapter', async () => {
  const f = hostFixture({ withdrawFailure: true, stopFailure: true, closeFailure: true })
  void f.start('postgresql').catch(() => {})
  try {
    await f.publishing.promise
    f.publishAck.resolve()
    await f.announced.promise
    void f.requestShutdown().catch(() => {})
    await f.withdrawing.promise
    f.withdrawAck.resolve()
    await f.closing.promise
    f.closeAck.resolve()
    await f.terminated.promise
    expect(f.warnings).toEqual([
      'daemon readiness withdrawal error',
      'daemon shutdown error',
      'daemon control close error',
    ])
    expect(f.events.filter((event) => event === 'bootstrap-stop')).toHaveLength(1)
    expect(f.events.filter((event) => event === 'terminate:0')).toHaveLength(1)
  } finally {
    await f.cleanup()
  }
}, 20_000)

test('fast control close cannot exit before late ready and final withdrawal ACKs', async () => {
  const f = hostFixture({ holdFinalWithdrawal: true })
  void f.start('sqlite').catch(() => {})
  try {
    await f.publishing.promise
    void f.requestShutdown('SIGTERM').catch(() => {})
    await f.withdrawing.promise
    f.withdrawAck.resolve()
    await f.closing.promise
    f.closeAck.resolve()
    // Complete the fixture's immediate close continuation before releasing the
    // publication; this is an event-loop turn, not a guessed timing delay.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.events).toContain('control-close:ack')
    expect(f.events).not.toContain('lock-release')
    expect(f.events).not.toContain('terminate:0')
    f.publishAck.resolve()
    await f.finalWithdrawing.promise
    expect(f.host.readCurrent()).not.toBeNull()
    expect(f.events).not.toContain('lock-release')
    expect(f.events).not.toContain('terminate:0')
    f.finalWithdrawAck.resolve()
    await f.lateWithdrawn.promise
    expect(f.host.readCurrent()).toBeNull()
    expect(f.events).not.toContain('bootstrap-required')
    expect(f.events).not.toContain('announce')
    await f.terminated.promise
  } finally {
    await f.cleanup()
  }
}, 20_000)

test('subscription failure unwinds the listener and business runtime before returning its original error', async () => {
  const f = hostFixture({ subscriptionFailure: true })
  const serving = f.start('postgresql')
  void serving.catch(() => {})
  try {
    await f.withdrawing.promise
    f.withdrawAck.resolve()
    await expect(serving).rejects.toThrow('host control subscription failed')
    expect(f.events).toContain('bootstrap-stop')
    expect(f.events).toContain('lock-release')
    expect(f.events).not.toContain('publish:enter')
    expect(f.events).not.toContain('terminate:0')
  } finally {
    await f.cleanup()
  }
}, 20_000)

test('selected lifecycle and query keep the same prototype receiver; local readiness uses the original file format', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc370-host-local-'))
  const infoPath = join(root, '.daemon.info')
  try {
    const f = hostFixture()
    const options = { infoPath, controlPath: join(root, '.control'), pid: 818, devWatch: false }
    expect(selectDaemonHostLifecycle(f.host, options)).toBe(f.host)
    expect(selectDaemonRuntimeQueries(f.host, { infoPath })).toBe(f.host)
    expect(existsSync(infoPath)).toBe(false)
    const local = selectDaemonHostLifecycle(undefined, options)
    const readiness = {
      host: '127.0.0.1',
      port: 4100,
      url: 'http://127.0.0.1:4100/',
      startedAt: '2026-10-03T00:00:00.000Z',
    }
    await local.publishReady(readiness)
    expect(readFileSync(infoPath, 'utf8')).toBe(JSON.stringify({ pid: 818, ...readiness }, null, 2))
    expect(await local.readCurrent()).toEqual({ pid: 818, ...readiness })
    writeFileSync(infoPath, '{ malformed')
    expect(await local.readCurrent()).toBeNull()
    await local.withdrawReady()
    await local.withdrawReady()
    expect(existsSync(infoPath)).toBe(false)
    expect(await selectDaemonRuntimeQueries(undefined, { infoPath }).readCurrent()).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
