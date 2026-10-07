import { expect, test } from 'bun:test'
import { createHostExecutionAuthorityLifecycle } from '../src/modules/system-operations/application/hostExecutionAuthority'
import { runDaemonHostApplication } from '../src/modules/system-operations/application/daemonHostApplication'
import { runDaemonStartupWithLease } from '../src/modules/system-operations/application/daemonStartupLease'
import type { DaemonStartupLease } from '../src/modules/system-operations/application/ports/daemonStartupLease'
import type {
  DaemonHostLifecyclePort,
  DaemonHostShutdownCallbacks,
} from '../src/modules/system-operations/application/ports/daemonHostLifecycle'
import { createLocalHostExecutionAuthorityFactory } from '../src/modules/system-operations/infrastructure/local/hostExecutionAuthority'

const nextTurn = () => new Promise<void>((accept) => setImmediate(accept))

function nativeFixture(provider: 'sqlite' | 'postgresql') {
  const events: string[] = []
  const releaseEntered = Promise.withResolvers<void>()
  const releaseAck = Promise.withResolvers<void>()
  const lease: DaemonStartupLease = Object.freeze({
    get diagnostics(): Readonly<Record<string, unknown>> {
      throw new Error('runtime grant must not inspect native PID diagnostics')
    },
    recoveryAuthority() {
      throw new Error('runtime grant must not reacquire the original Task recovery receipt')
    },
    async release() {
      expect<DaemonStartupLease>(this).toBe(lease)
      events.push('pid-release:enter')
      releaseEntered.resolve()
      await releaseAck.promise
      events.push('pid-release:ack')
    },
    releaseOnExit() {
      events.push('pid-exit-release')
    },
  })
  const factory = createLocalHostExecutionAuthorityFactory({ startupLease: lease })
  const driver = factory.create({ provider, generation: 'original-native-generation' })
  // Local factory creation and its control methods remain synchronous.
  if ('then' in driver) throw new Error('native factory unexpectedly deferred')
  const lifecycle = createHostExecutionAuthorityLifecycle({
    generation: 'original-native-generation',
    mode: 'execution',
    driver,
    recovery: {
      kind: 'local-startup',
      prepare(context) {
        expect(context.current()).toBe(true)
        events.push('original-task-recovery')
        return {
          kind: 'prepared',
          preparationDigest: 'original-native-recovery-receipt',
          acceptedTaskContractVersions: ['task-intent:v1'],
          readyGroups: ['task'],
        }
      },
      quiesce() {
        events.push('recovery-quiesce')
      },
      drain() {
        events.push('recovery-drain')
      },
    },
    runtime: {
      start() {
        events.push('runtime-start')
      },
      quiesce() {
        events.push('runtime-quiesce')
      },
      drain() {
        events.push('runtime-drain')
      },
    },
    onFailure(error) {
      throw error
    },
  })
  return { lease, lifecycle, events, releaseEntered, releaseAck }
}

for (const provider of ['sqlite', 'postgresql'] as const) {
  test(`${provider} runtime grant retirement leaves the original startup PID lease owned by the host`, async () => {
    const f = nativeFixture(provider)
    await f.lifecycle.start()
    await f.lifecycle.renew()
    await f.lifecycle.close()
    expect(f.lifecycle.queries.snapshot().phase).toBe('closed')
    expect(f.events).toEqual([
      'original-task-recovery',
      'runtime-start',
      'runtime-quiesce',
      'recovery-quiesce',
      'runtime-drain',
      'recovery-drain',
    ])
    const releasing = f.lease.release()
    await f.releaseEntered.promise
    expect(f.events.at(-1)).toBe('pid-release:enter')
    f.releaseAck.resolve()
    await releasing
    expect(f.events.at(-1)).toBe('pid-release:ack')
  })

  test(`${provider} real daemon host waits for listener, runtime and control ACKs before PID release`, async () => {
    const f = nativeFixture(provider)
    await f.lifecycle.start()
    const announced = Promise.withResolvers<void>()
    const controlCloseEntered = Promise.withResolvers<void>()
    const controlCloseAck = Promise.withResolvers<void>()
    const terminated = Promise.withResolvers<void>()
    const subscription: { callbacks?: DaemonHostShutdownCallbacks } = {}
    const host: DaemonHostLifecyclePort = {
      readCurrent: () => null,
      publishReady() {
        f.events.push('resource-ready')
      },
      withdrawReady() {
        f.events.push('withdraw-ready')
      },
      subscribeShutdown(input) {
        subscription.callbacks = input
        return {
          async close() {
            f.events.push('host-control-close:enter')
            controlCloseEntered.resolve()
            await controlCloseAck.promise
            f.events.push('host-control-close:ack')
          },
        }
      },
      announceReady() {
        announced.resolve()
      },
      terminate(): Promise<never> {
        terminated.resolve()
        return new Promise(() => {})
      },
    }
    const application = runDaemonHostApplication({
      host,
      databaseProvider: provider,
      readyInfo: () => ({
        host: '127.0.0.1',
        port: 4818,
        url: 'http://127.0.0.1:4818',
        startedAt: '2026-10-07T00:00:00Z',
      }),
      readBootstrapRequired: () => false,
      readyBrowserUrl: () => 'http://127.0.0.1:4818',
      stopListener() {
        f.events.push('listener-stop')
      },
      async stopApplication() {
        await f.lifecycle.close()
        f.events.push('provider-close:ack')
      },
      releaseAuthority: () => f.lease.release(),
      releaseAuthorityOnExit: () => f.lease.releaseOnExit(),
      describeFailure: String,
      log: { info() {}, warn() {} },
    })
    application.catch((error) => announced.reject(error))
    await announced.promise
    const callbacks = subscription.callbacks
    if (!callbacks) throw new Error('original host did not register shutdown')
    const shuttingDown = callbacks.onShutdown('native-host-shutdown')
    if (shuttingDown instanceof Promise) shuttingDown.catch((error) => terminated.reject(error))
    await controlCloseEntered.promise
    expect(f.events).not.toContain('pid-release:enter')
    expect(f.lifecycle.queries.snapshot().phase).toBe('closed')
    controlCloseAck.resolve()
    await f.releaseEntered.promise
    expect(f.events.indexOf('listener-stop')).toBeLessThan(f.events.indexOf('runtime-quiesce'))
    expect(f.events.indexOf('provider-close:ack')).toBeLessThan(
      f.events.indexOf('host-control-close:ack'),
    )
    expect(f.events.indexOf('host-control-close:ack')).toBeLessThan(
      f.events.indexOf('pid-release:enter'),
    )
    f.releaseAck.resolve()
    await terminated.promise
    expect(f.events.at(-1)).toBe('pid-release:ack')
  })

  test(`${provider} failed boot retains the original release ACK and failure identity`, async () => {
    const f = nativeFixture(provider)
    const failure = new Error('original-native-boot-failed')
    let observed: unknown
    const boot = runDaemonStartupWithLease(f.lease, async () => {
      await f.lifecycle.start()
      await f.lifecycle.close()
      expect(f.events).not.toContain('pid-release:enter')
      throw failure
    }).catch((error: unknown) => {
      observed = error
    })
    await f.releaseEntered.promise
    await nextTurn()
    expect(observed).toBeUndefined()
    expect(f.events).not.toContain('pid-release:ack')
    f.releaseAck.resolve()
    await boot
    expect(observed).toBe(failure)
  })
}

test('embedded HTTP native choice does not acquire a global PID lease', async () => {
  const factory = createLocalHostExecutionAuthorityFactory()
  const driver = factory.create({ provider: 'sqlite', generation: 'embedded-http' })
  if ('then' in driver) throw new Error('embedded native factory unexpectedly deferred')
  const granted = driver.claim()
  if ('then' in granted || granted.kind !== 'granted')
    throw new Error('expected synchronous native grant')
  expect(driver.renew(granted.reference)).toEqual(granted)
  expect(driver.quiesce({ reference: granted.reference, reason: 'shutdown' })).toBeUndefined()
  expect(driver.release(granted.reference)).toBeUndefined()
})
