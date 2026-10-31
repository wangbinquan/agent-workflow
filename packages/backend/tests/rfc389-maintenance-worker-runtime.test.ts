import { openMaintenanceWorkerEffectsScope } from '@/bootstrap/maintenanceWorkerEffects'
// RFC-389 — graph composition failures must retain the original close/drain event ordering.
// Execute the real runtime with a graph port; no Worker entry is imported on the main thread.
import { expect, test } from 'bun:test'
import { runMaintenanceWorker } from '@/platform/background/maintenanceWorkerRuntime'
import { MAINTENANCE_CATALOG_DIGEST } from '@/platform/background/maintenanceCatalog'
import {
  MAINTENANCE_PROTOCOL_VERSION,
  type MaintenanceWorkerEvent,
} from '@/platform/background/maintenanceProtocol'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const init = {
  type: 'init',
  version: MAINTENANCE_PROTOCOL_VERSION,
  catalogDigest: MAINTENANCE_CATALOG_DIGEST,
  appHome: '/unused-home',
  dbPath: '/unused-db',
  migrationsFolder: '/unused-migrations',
  sqlite: { synchronous: 'NORMAL', pageCacheMib: 8, mmapMib: 0, busyTimeoutMs: 50 },
}
async function withWorker(
  body: (worker: {
    send(data: unknown): void
    readonly events: MaintenanceWorkerEvent[]
    readonly drained: Promise<void>
    readonly degraded: Promise<void>
  }) => Promise<void>,
): Promise<void> {
  const original = Object.getOwnPropertyDescriptors(globalThis)
  const events: MaintenanceWorkerEvent[] = []
  const drained = gate(),
    degraded = gate()
  const target = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    addEventListener() {},
  }
  Object.defineProperty(globalThis, 'self', { configurable: true, value: target })
  Object.defineProperty(globalThis, 'postMessage', {
    configurable: true,
    value: (event: MaintenanceWorkerEvent) => {
      events.push(event)
      if (event.type === 'drained') drained.release()
      if (event.type === 'degraded') degraded.release()
    },
  })
  try {
    await body({
      send: (data) => target.onmessage!({ data }),
      events,
      drained: drained.promise,
      degraded: degraded.promise,
    })
  } finally {
    for (const key of ['self', 'postMessage']) {
      const descriptor = original[key]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('an opened connection survives failed composition until close ACK, then degraded and deferred drain arrive', async () => {
  await withWorker(async (worker) => {
    const closing = gate(),
      closeAck = gate()
    let closed = 0
    runMaintenanceWorker({
      openEffectsScope: openMaintenanceWorkerEffectsScope,
      composeGraph: async ({ registerConnectionClose }) => {
        registerConnectionClose(async () => {
          closed++
          closing.release()
          await closeAck.promise
        })
        await Promise.resolve()
        throw new Error('graph-composition-failed', { cause: new Error('original-cause') })
      },
    })
    worker.send(init)
    worker.send({ type: 'drain', version: MAINTENANCE_PROTOCOL_VERSION })
    await closing.promise
    expect(closed).toBe(1)
    expect(worker.events).toEqual([])
    closeAck.release()
    await worker.drained
    expect(worker.events.map((event) => event.type)).toEqual(['degraded', 'drained'])
    expect(worker.events[0]).toMatchObject({ error: 'graph-composition-failed <- original-cause' })
    expect(closed).toBe(1)
  })
})

test('catalog mismatch rejects before opening a graph', async () => {
  await withWorker(async (worker) => {
    let constructed = 0
    runMaintenanceWorker({
      openEffectsScope: openMaintenanceWorkerEffectsScope,
      composeGraph: async () => {
        constructed++
        throw new Error('must not compose')
      },
    })
    worker.send({ ...init, catalogDigest: '0'.repeat(64) })
    await worker.degraded
    expect(constructed).toBe(0)
    expect(worker.events).toHaveLength(1)
    expect(worker.events[0]).toMatchObject({
      type: 'degraded',
      error: 'maintenance-worker-catalog-digest-mismatch',
    })
  })
})
