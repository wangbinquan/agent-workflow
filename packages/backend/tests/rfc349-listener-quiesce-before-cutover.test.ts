// Locks the cutover regression found on 2026-09-02 in the local 100-client
// evidence run: two requests died mid-switch with
//   SQLiteError: no such table: agent_workflow.user_sessions
// and became user-visible 500s.
//
// `handover()` only queues NEW listener calls. The ones already dispatched to
// the outgoing composition keep running, and composing the target flips the
// process-wide table projection out from under them, so their next prepared
// statement is target-shaped SQL against the source client. The cutover now
// drains in-flight listener calls after arming the barrier and before composing
// — with an upper bound, because a stuck request must never strand a migration.
import { describe, expect, test } from 'bun:test'

import {
  createDaemonProviderListenerTraffic,
  createDaemonProviderRuntimeRouter,
} from '../src/cli/daemonProviderRuntimeRouter'
import {
  createDaemonProviderSessionController,
  type DaemonProviderSessionLifecycleInput,
  type ManagedDaemonProviderSession,
} from '../src/cli/daemonProviderSession'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('RFC-349 listener quiesce before a provider cutover', () => {
  test('quiesce resolves immediately when nothing is in flight', async () => {
    const traffic = createDaemonProviderListenerTraffic()
    const started = Date.now()

    await traffic.quiesce(5_000)

    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('quiesce waits for the last in-flight call to leave', async () => {
    const traffic = createDaemonProviderListenerTraffic()
    const first = traffic.enter()
    const second = traffic.enter()
    let drained = false
    const quiesced = traffic.quiesce(5_000).then(() => {
      drained = true
    })

    first()
    await Promise.resolve()
    expect(drained).toBe(false)

    second()
    await quiesced
    expect(drained).toBe(true)
  })

  test('a stuck call cannot stall the cutover past the bound', async () => {
    const traffic = createDaemonProviderListenerTraffic()
    traffic.enter() // never leaves

    const started = Date.now()
    await traffic.quiesce(50)

    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
  })

  test('leaving twice does not make the counter go negative', async () => {
    const traffic = createDaemonProviderListenerTraffic()
    const leave = traffic.enter()
    const other = traffic.enter()
    leave()
    leave()

    let drained = false
    const quiesced = traffic.quiesce(5_000).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained, 'the second call is still in flight').toBe(false)

    other()
    await quiesced
  })

  test('the router counts a request for exactly as long as it runs', async () => {
    const traffic = createDaemonProviderListenerTraffic()
    const gate = deferred<Response>()
    const session = {
      provider: 'sqlite' as const,
      generationId: 'sqlite-1',
      runtime: {
        fetch: () => gate.promise,
        tryUpgrade: () => false,
        websocketHandlers: { open: () => undefined },
      },
    }
    const router = createDaemonProviderRuntimeRouter(
      {
        current: () => session as never,
        handover: () => null,
      },
      traffic,
    )

    const pending = router.fetch(new Request('http://127.0.0.1/api/health'))
    let drained = false
    const quiesced = traffic.quiesce(5_000).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained, 'the request is still running').toBe(false)

    gate.resolve(new Response('ok'))
    await pending
    await quiesced
    expect(drained).toBe(true)
  })
})

describe('RFC-349 the cutover drains the listener before composing', () => {
  function managed(provider: 'sqlite' | 'postgresql', generationId: string, order: string[]) {
    return Object.freeze({
      provider,
      generationId,
      async pause() {
        order.push(`pause:${provider}`)
      },
      async resume() {
        order.push(`resume:${provider}`)
      },
      async close() {
        order.push(`close:${provider}`)
      },
    }) satisfies ManagedDaemonProviderSession
  }

  test('quiesceListener is awaited before the target composition is built', async () => {
    const order: string[] = []
    const lifecycle: DaemonProviderSessionLifecycleInput = {
      operationId: 'op-1',
      provider: 'postgresql',
      generationId: 'pg-1',
    }
    const controller = createDaemonProviderSessionController({
      initial: managed('sqlite', 'sqlite-1', order),
      factory: {
        async create() {
          order.push('compose:postgresql')
          return managed('postgresql', 'pg-1', order)
        },
      },
      quiesceListener: async () => {
        order.push('quiesce')
      },
    })

    await controller.pauseBackgroundWriters({
      operationId: 'op-1',
      provider: 'sqlite',
      generationId: 'sqlite-1',
    })
    await controller.switchProviderComposition(lifecycle)

    expect(order.indexOf('quiesce')).toBeGreaterThan(-1)
    expect(
      order.indexOf('quiesce'),
      'composing the target flips process-wide provider state; in-flight calls must be gone first',
    ).toBeLessThan(order.indexOf('compose:postgresql'))
  })

  test('a same-generation switch is a no-op and does not drain the listener', async () => {
    const order: string[] = []
    const lifecycle: DaemonProviderSessionLifecycleInput = {
      operationId: 'op-1',
      provider: 'sqlite',
      generationId: 'sqlite-1',
    }
    const controller = createDaemonProviderSessionController({
      initial: managed('sqlite', 'sqlite-1', order),
      factory: {
        async create() {
          throw new Error('must not compose')
        },
      },
      quiesceListener: async () => {
        order.push('quiesce')
      },
    })

    await controller.pauseBackgroundWriters(lifecycle)
    await controller.switchProviderComposition(lifecycle)

    expect(order).not.toContain('quiesce')
  })
})
