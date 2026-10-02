// RFC-370 A1: the owner application drains readiness and release ACKs in order.
import { expect, test } from 'bun:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { runDaemonHostApplication } from '@/modules/system-operations/application/daemonHostApplication'
import type {
  DaemonHostLifecyclePort,
  DaemonHostShutdownCallbacks,
} from '@/modules/system-operations/application/ports/daemonHostLifecycle'

test('selected host withdrawal and orderly authority release finish before terminate', async () => {
  const events: string[] = []
  const callbacks = Promise.withResolvers<DaemonHostShutdownCallbacks>()
  const published = Promise.withResolvers<void>()
  const publicationAck = Promise.withResolvers<void>()
  const finalWithdrawal = Promise.withResolvers<void>()
  const withdrawalAck = Promise.withResolvers<void>()
  const releaseEntered = Promise.withResolvers<void>()
  const releaseAck = Promise.withResolvers<void>()
  const exited = new Error('selected host terminated')
  let withdrawals = 0
  let unexpectedRelease = 0
  class Host implements DaemonHostLifecyclePort {
    readCurrent() {
      return null
    }
    subscribeShutdown(input: DaemonHostShutdownCallbacks) {
      expect<DaemonHostLifecyclePort>(this).toBe(host)
      events.push('subscribe')
      callbacks.resolve(input)
      return {
        close() {
          events.push('control-close')
        },
      }
    }
    async publishReady(input: Parameters<DaemonHostLifecyclePort['publishReady']>[0]) {
      expect<DaemonHostLifecyclePort>(this).toBe(host)
      expect(input).toEqual({ host: 'selected', port: 42, url: 'logical:host', startedAt: 'now' })
      events.push('publication-enter')
      published.resolve()
      await publicationAck.promise
      events.push('publication-ack')
    }
    async withdrawReady() {
      expect<DaemonHostLifecyclePort>(this).toBe(host)
      withdrawals += 1
      events.push(`withdraw-${withdrawals}`)
      if (withdrawals === 2) {
        finalWithdrawal.resolve()
        await withdrawalAck.promise
        events.push('withdraw-final-ack')
      }
    }
    announceReady(): void {
      throw new Error('a draining host must not announce readiness')
    }
    terminate(code: number): never {
      expect<DaemonHostLifecyclePort>(this).toBe(host)
      expect(code).toBe(0)
      events.push('terminate')
      throw exited
    }
  }
  const host: DaemonHostLifecyclePort = Object.freeze(new Host())
  expect(Object.keys(host)).toEqual([])
  const run = runDaemonHostApplication({
    host,
    databaseProvider: 'selected-provider',
    readyInfo: () => ({ host: 'selected', port: 42, url: 'logical:host', startedAt: 'now' }),
    readBootstrapRequired() {
      throw new Error('a draining host must not query bootstrap')
    },
    readyBrowserUrl() {
      throw new Error('a draining host must not form a browser URL')
    },
    stopListener() {
      events.push('listener-stop')
    },
    stopApplication() {
      events.push('application-stop')
    },
    async releaseAuthority() {
      events.push('release-enter')
      releaseEntered.resolve()
      await releaseAck.promise
      events.push('release-ack')
    },
    releaseAuthorityOnExit() {
      unexpectedRelease += 1
    },
    describeFailure: String,
    log: { info() {}, warn() {} },
  })
  void run.catch(() => {})
  let shutdown: Promise<void> | undefined
  try {
    await Promise.race([published.promise, run])
    shutdown = Promise.resolve((await callbacks.promise).onShutdown('test'))
    void shutdown.catch(() => {})
    await nextTurn()
    expect(events).toEqual([
      'subscribe',
      'publication-enter',
      'withdraw-1',
      'listener-stop',
      'application-stop',
      'control-close',
    ])
    publicationAck.resolve()
    await finalWithdrawal.promise
    expect(events).not.toContain('release-enter')
    expect(events).not.toContain('terminate')
    withdrawalAck.resolve()
    await releaseEntered.promise
    expect(events).not.toContain('release-ack')
    expect(events).not.toContain('terminate')
    releaseAck.resolve()
    await expect(shutdown).rejects.toBe(exited)
    expect(events.slice(-5)).toEqual([
      'withdraw-2',
      'withdraw-final-ack',
      'release-enter',
      'release-ack',
      'terminate',
    ])
    expect(unexpectedRelease).toBe(0)
    ;(await callbacks.promise).onExit()
    expect(unexpectedRelease).toBe(1)
  } finally {
    publicationAck.resolve()
    withdrawalAck.resolve()
    releaseAck.resolve()
    await shutdown?.catch(() => {})
  }
}, 20_000)
