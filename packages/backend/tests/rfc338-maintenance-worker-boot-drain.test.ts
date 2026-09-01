// Locks the maintenance Worker boot race observed in ~/.agent-workflow/logs/daemon.log
// on 2026-09-01 (first occurrence 03:16:33Z, then once per daemon boot):
//
//   ERROR [maintenance-service] maintenance worker degraded error=maintenance-worker-already-initialised
//   ERROR [maintenance-service] maintenance worker degraded error=maintenance-worker-first-message-must-be-init
//
// Daemon boot starts the maintenance service and immediately pauses it until
// the first provider session resume (cli/start.ts ->
// createPausableDaemonRuntimeServiceBindings), so `drain` reaches the Worker
// while `init` is still in flight. The Worker used to route every pre-ready
// frame into initialise(), which reported `already-initialised`, ran
// closeConnection() over the connection the in-flight init was still opening
// ("Cannot use a closed database"), and left the generation unable to answer
// the supervisor's post-`ready` wake. No `drained` receipt ever arrived, so
// every boot burned the full 10s pause timeout: 08:33:23.940 lock acquired ->
// 08:33:36.281 listening, against 1.7s on a healthy build.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { MAINTENANCE_CATALOG_DIGEST } from '@/platform/background/maintenanceCatalog'
import { MAINTENANCE_PROTOCOL_VERSION } from '@/platform/background/maintenanceProtocol'
import { routeMaintenanceWorkerRequest } from '@/platform/background/maintenanceWorkerMessageRouter'
import { startMaintenanceWorkerSupervisor } from '@/platform/background/maintenanceWorkerSupervisor'
import { MIGRATIONS } from './migration-freeze'

const INIT = Object.freeze({
  type: 'init',
  version: MAINTENANCE_PROTOCOL_VERSION,
  catalogDigest: MAINTENANCE_CATALOG_DIGEST,
  dbPath: '/tmp/rfc338-boot-drain.sqlite',
  migrationsFolder: '/tmp/rfc338-boot-drain-migrations',
  appHome: '/tmp/rfc338-boot-drain',
  sqlite: Object.freeze({
    synchronous: 'NORMAL',
    pageCacheMib: 8,
    mmapMib: 0,
    busyTimeoutMs: 50,
  }),
})
const WAKE = Object.freeze({ type: 'wake', version: MAINTENANCE_PROTOCOL_VERSION })
const DRAIN = Object.freeze({ type: 'drain', version: MAINTENANCE_PROTOCOL_VERSION })

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => unknown) | null = null
  readonly messages: unknown[] = []
  terminated = false
  postMessage(message: unknown): void {
    this.messages.push(message)
  }
  terminate(): void {
    this.terminated = true
  }
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>)
  }
  typesOf(type: string): unknown[] {
    return this.messages.filter((message) => (message as { type?: string }).type === type)
  }
}

describe('RFC-338 maintenance Worker boot drain', () => {
  test('a drain racing init is deferred, never re-entered as an init attempt', () => {
    expect(routeMaintenanceWorkerRequest('initialising', DRAIN)).toEqual({ kind: 'defer-drain' })
    // Once init has settled either way the drain is answered immediately: a
    // ready generation closes its connection, an idle one has none to close.
    expect(routeMaintenanceWorkerRequest('ready', DRAIN)).toEqual({ kind: 'drain' })
    expect(routeMaintenanceWorkerRequest('idle', DRAIN)).toEqual({ kind: 'drain' })
  })

  test('init is accepted once and a repeat is reported without implying a teardown', () => {
    expect(routeMaintenanceWorkerRequest('idle', INIT)).toEqual({
      kind: 'initialise',
      request: INIT,
    })
    expect(routeMaintenanceWorkerRequest('initialising', INIT)).toEqual({
      kind: 'fail',
      error: 'maintenance-worker-already-initialised',
    })
    expect(routeMaintenanceWorkerRequest('ready', INIT)).toEqual({
      kind: 'fail',
      error: 'maintenance-worker-init-after-ready',
    })
  })

  test('a wake only polls a ready generation and is otherwise dropped', () => {
    expect(routeMaintenanceWorkerRequest('ready', WAKE)).toEqual({ kind: 'wake' })
    expect(routeMaintenanceWorkerRequest('initialising', WAKE)).toEqual({
      kind: 'ignore',
      reason: 'wake-before-ready',
    })
    expect(routeMaintenanceWorkerRequest('idle', WAKE)).toEqual({
      kind: 'ignore',
      reason: 'wake-before-ready',
    })
  })

  test('frames the protocol rejects still throw for the degraded path', () => {
    expect(() => routeMaintenanceWorkerRequest('ready', { type: 'wake', version: 2 })).toThrow()
    expect(() => routeMaintenanceWorkerRequest('idle', { type: 'nope' })).toThrow()
  })

  test('the Worker never routes a raw frame into initialise()', () => {
    const source = readFileSync(
      new URL('../src/platform/background/maintenanceWorker.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toContain('initialise(event.data)')
    expect(source).toContain('routeMaintenanceWorkerRequest(')
  })

  test('pause before the handshake drains without waking the generation', async () => {
    const first = new FakeWorker()
    const second = new FakeWorker()
    const workers: FakeWorker[] = [first, second]
    const supervisor = startMaintenanceWorkerSupervisor({
      dbPath: '/tmp/rfc338-boot-drain.sqlite',
      migrationsFolder: MIGRATIONS,
      appHome: '/tmp/rfc338-boot-drain',
      sqlite: { synchronous: 'NORMAL', pageCacheMib: 8, mmapMib: 0 },
      workerFactory: () => workers.shift()!,
    })
    expect(first.messages[0]).toMatchObject({ type: 'init' })

    // Boot pauses the service the moment it is composed, long before `ready`.
    const paused = supervisor.pause()
    expect(first.messages.at(-1)).toMatchObject({ type: 'drain' })

    // Even if this generation still announces readiness, a paused supervisor
    // must not admit a slice it is waiting to see finish.
    first.emit({
      type: 'ready',
      version: MAINTENANCE_PROTOCOL_VERSION,
      catalogDigest: MAINTENANCE_CATALOG_DIGEST,
      at: 10,
    })
    expect(first.typesOf('wake')).toEqual([])

    first.emit({ type: 'drained', version: MAINTENANCE_PROTOCOL_VERSION, at: 20 })
    await paused
    expect(first.terminated).toBe(true)
    expect(supervisor.live()).toMatchObject({ state: 'stopped', active: null })

    await supervisor.resume()
    expect(second.messages[0]).toMatchObject({ type: 'init' })
    const stopping = supervisor.stop()
    second.emit({ type: 'drained', version: MAINTENANCE_PROTOCOL_VERSION, at: 30 })
    await stopping
    expect(second.terminated).toBe(true)
  })
})
