import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '@/db/client'
import { MAINTENANCE_CATALOG_DIGEST } from '@/platform/background/maintenanceCatalog'
import {
  MAINTENANCE_PROTOCOL_VERSION,
  MaintenanceWorkerEventSchema,
  MaintenanceWorkerRequestSchema,
} from '@/platform/background/maintenanceProtocol'
import { startMaintenanceWorkerSupervisor } from '@/platform/background/maintenanceWorkerSupervisor'
import { createMaintenanceRunStore } from '@/platform/persistence/sqlite/maintenanceRunStore'
import { MIGRATIONS } from './migration-freeze'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-338 maintenance Worker', () => {
  test('protocol rejects unknown versions, jobs, and delta shapes', () => {
    expect(MaintenanceWorkerRequestSchema.safeParse({ type: 'wake', version: 2 }).success).toBe(
      false,
    )
    expect(
      MaintenanceWorkerEventSchema.safeParse({
        type: 'active',
        version: MAINTENANCE_PROTOCOL_VERSION,
        runId: 'run',
        job: 'unknown-job',
        startedAt: 1,
      }).success,
    ).toBe(false)
    expect(
      MaintenanceWorkerEventSchema.safeParse({
        type: 'completed',
        version: MAINTENANCE_PROTOCOL_VERSION,
        runId: 'run',
        job: 'tokenAuditGc',
        outcome: 'succeeded',
        counters: {},
        delta: { kind: 'intent-queued', sessionIds: [], extra: true },
        finishedAt: 1,
      }).success,
    ).toBe(false)
  })

  test('supervisor restarts a crashed Worker, fences its late event, and drains the replacement', async () => {
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
    }
    const first = new FakeWorker()
    const second = new FakeWorker()
    const workers = [first, second]
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
    const supervisor = startMaintenanceWorkerSupervisor({
      dbPath: '/tmp/rfc338-supervisor.sqlite',
      migrationsFolder: MIGRATIONS,
      appHome: '/tmp/rfc338-supervisor',
      sqlite: { synchronous: 'NORMAL', pageCacheMib: 8, mmapMib: 0 },
      workerFactory: () => workers.shift()!,
      setTimer: (fn, ms) => {
        const timer = { fn, ms, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: (value) => {
        ;(value as { cleared: boolean }).cleared = true
      },
    })
    expect(first.messages[0]).toMatchObject({ type: 'init', version: MAINTENANCE_PROTOCOL_VERSION })
    first.onerror?.({ message: 'worker-crashed' } as ErrorEvent)
    expect(first.terminated).toBe(true)
    expect(supervisor.live()).toMatchObject({ state: 'degraded', error: 'worker-crashed' })

    const restart = timers.find((timer) => !timer.cleared && timer.ms === 250)
    expect(restart).toBeDefined()
    restart!.fn()
    second.emit({
      type: 'ready',
      version: MAINTENANCE_PROTOCOL_VERSION,
      catalogDigest: MAINTENANCE_CATALOG_DIGEST,
      at: 100,
    })
    expect(supervisor.live()).toMatchObject({ state: 'ready', error: null })

    // A queued ErrorEvent from the terminated generation must not tear down
    // the healthy replacement.
    first.onerror?.({ message: 'late-old-worker-error' } as ErrorEvent)
    expect(second.terminated).toBe(false)
    expect(supervisor.live()).toMatchObject({ state: 'ready', error: null })

    const drained = supervisor.drain()
    expect(second.messages.at(-1)).toMatchObject({ type: 'drain' })
    second.emit({ type: 'drained', version: MAINTENANCE_PROTOCOL_VERSION, at: 200 })
    await drained
    expect(second.terminated).toBe(true)
    expect(supervisor.live()).toMatchObject({ state: 'stopped', active: null })
  })

  test('supervisor restarts a Worker whose heartbeat stops without an ErrorEvent', async () => {
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
    }
    const first = new FakeWorker()
    const second = new FakeWorker()
    const workers = [first, second]
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
    let now = 1_000
    const supervisor = startMaintenanceWorkerSupervisor({
      dbPath: '/tmp/rfc338-heartbeat.sqlite',
      migrationsFolder: MIGRATIONS,
      appHome: '/tmp/rfc338-heartbeat',
      sqlite: { synchronous: 'NORMAL', pageCacheMib: 8, mmapMib: 0 },
      workerFactory: () => workers.shift()!,
      now: () => now,
      heartbeatTimeoutMs: 900,
      setTimer: (fn, ms) => {
        const timer = { fn, ms, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: (value) => {
        ;(value as { cleared: boolean }).cleared = true
      },
    })
    first.emit({
      type: 'ready',
      version: MAINTENANCE_PROTOCOL_VERSION,
      catalogDigest: MAINTENANCE_CATALOG_DIGEST,
      at: now,
    })
    const watchdog = timers.find((timer) => !timer.cleared && timer.ms === 300)
    expect(watchdog).toBeDefined()

    now += 901
    watchdog!.fn()
    expect(first.terminated).toBe(true)
    expect(supervisor.live()).toMatchObject({
      state: 'degraded',
      error: 'maintenance worker heartbeat timed out',
    })

    const restart = timers.find((timer) => !timer.cleared && timer.ms === 250)
    expect(restart).toBeDefined()
    restart!.fn()
    second.emit({
      type: 'ready',
      version: MAINTENANCE_PROTOCOL_VERSION,
      catalogDigest: MAINTENANCE_CATALOG_DIGEST,
      at: now,
    })
    first.emit({
      type: 'degraded',
      version: MAINTENANCE_PROTOCOL_VERSION,
      at: now,
      error: 'late-old-worker-event',
    })
    expect(second.terminated).toBe(false)
    expect(supervisor.live()).toMatchObject({ state: 'ready', error: null })

    const drained = supervisor.drain()
    second.emit({ type: 'drained', version: MAINTENANCE_PROTOCOL_VERSION, at: now })
    await drained
  })

  test('claims and settles a real SQLite job through its own Worker entrypoint', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc338-worker-'))
    roots.push(appHome)
    const dbPath = join(appHome, 'db.sqlite')
    const db = openDb({
      path: dbPath,
      migrationsFolder: MIGRATIONS,
      skipIntegrityCheck: true,
      slowQueryMs: 0,
    })
    createMaintenanceRunStore(db).enqueue({
      id: 'worker-run',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'test:1',
      payload: { retentionDays: 90 },
      scheduledAt: 0,
      now: 0,
    })

    let resolveCompleted!: (value: { outcome: string; error?: string }) => void
    let deferredSlices = 0
    const completed = new Promise<{ outcome: string; error?: string }>((resolve) => {
      resolveCompleted = resolve
    })
    const supervisor = startMaintenanceWorkerSupervisor({
      dbPath,
      migrationsFolder: MIGRATIONS,
      appHome,
      sqlite: { synchronous: 'NORMAL', pageCacheMib: 8, mmapMib: 0 },
      onEvent: (event) => {
        if (event.type === 'completed' && event.runId === 'worker-run') {
          if (event.outcome === 'deferred') {
            deferredSlices += 1
            return
          }
          resolveCompleted({ outcome: event.outcome, error: event.errorMessage })
        }
        if (event.type === 'degraded') {
          resolveCompleted({ outcome: 'degraded', error: event.error })
        }
      },
    })

    const timeout = new Promise<{ outcome: string; error?: string }>((resolve) => {
      const handle = setTimeout(() => resolve({ outcome: 'timeout' }), 10_000)
      handle.unref?.()
    })
    const result = await Promise.race([completed, timeout])
    expect(result).toEqual({ outcome: 'succeeded', error: undefined })
    expect(deferredSlices).toBe(1)
    const settled = createMaintenanceRunStore(db).read('worker-run')
    expect(settled).toMatchObject({
      state: 'succeeded',
      attempt: 2,
      sliceNo: 2,
    })
    expect(JSON.parse(settled!.countersJson)).toMatchObject({
      audits: 0,
      snapshots: 0,
      workerSliceCount: 2,
      dbStatementCount: 2,
    })

    await supervisor.drain()
    ;(db as unknown as { $client: { close(): void } }).$client.close()
  }, 15_000)

  test('transient claim-ledger BUSY defers in place instead of degrading the Worker', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc338-worker-claim-busy-'))
    roots.push(appHome)
    const dbPath = join(appHome, 'db.sqlite')
    const db = openDb({
      path: dbPath,
      migrationsFolder: MIGRATIONS,
      skipIntegrityCheck: true,
      slowQueryMs: 0,
    })
    createMaintenanceRunStore(db).enqueue({
      id: 'claim-busy-run',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'test:claim-busy',
      payload: { retentionDays: 90 },
      scheduledAt: Date.now() + 60_000,
      now: Date.now(),
    })

    let resolveReady!: () => void
    let resolvePostWakeHeartbeat!: () => void
    let resolveCompleted!: (counters: Readonly<Record<string, number>>) => void
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const postWakeHeartbeat = new Promise<void>((resolve) => {
      resolvePostWakeHeartbeat = resolve
    })
    const completed = new Promise<Readonly<Record<string, number>>>((resolve) => {
      resolveCompleted = resolve
    })
    let waitingForPostWakeHeartbeat = false
    const degraded: string[] = []
    const supervisor = startMaintenanceWorkerSupervisor({
      dbPath,
      migrationsFolder: MIGRATIONS,
      appHome,
      sqlite: { synchronous: 'NORMAL', pageCacheMib: 8, mmapMib: 0, busyTimeoutMs: 50 },
      onEvent: (event) => {
        if (event.type === 'ready') resolveReady()
        if (event.type === 'heartbeat' && waitingForPostWakeHeartbeat) {
          resolvePostWakeHeartbeat()
        }
        if (
          event.type === 'completed' &&
          event.runId === 'claim-busy-run' &&
          event.outcome === 'succeeded'
        ) {
          resolveCompleted(event.counters)
        }
        if (event.type === 'degraded') degraded.push(event.error)
      },
    })
    const sqlite = (db as unknown as { $client: { exec(sql: string): void; close(): void } })
      .$client
    let inTransaction = false
    try {
      await ready
      sqlite.exec('BEGIN IMMEDIATE;')
      inTransaction = true
      sqlite.exec("UPDATE maintenance_runs SET scheduled_at = 0 WHERE id = 'claim-busy-run';")
      waitingForPostWakeHeartbeat = true
      supervisor.wake()
      // `wake` is posted well before the Worker's first 5s heartbeat. Its
      // handler calls claimNext synchronously before yielding into the BUSY
      // backoff, so observing that heartbeat proves the locked claim path ran.
      // A fixed sleep races a loaded hosted runner and can release the lock
      // before the Worker has handled `wake`.
      const heartbeatTimeout = new Promise<'timeout'>((resolve) => {
        const handle = setTimeout(() => resolve('timeout'), 8_000)
        handle.unref?.()
      })
      expect(
        await Promise.race([postWakeHeartbeat.then(() => 'heartbeat' as const), heartbeatTimeout]),
      ).toBe('heartbeat')
      expect(degraded).toEqual([])
      sqlite.exec('COMMIT;')
      inTransaction = false

      const timeout = new Promise<Readonly<Record<string, number>>>((resolve) => {
        const handle = setTimeout(() => resolve({ timeout: 1 }), 15_000)
        handle.unref?.()
      })
      const counters = await Promise.race([completed, timeout])
      expect(counters.timeout).toBeUndefined()
      expect(counters.sqliteBusyDeferrals).toBeGreaterThanOrEqual(1)
      expect(degraded).toEqual([])
    } finally {
      if (inTransaction) sqlite.exec('ROLLBACK;')
      await supervisor.drain()
      sqlite.close()
    }
  }, 25_000)
})
