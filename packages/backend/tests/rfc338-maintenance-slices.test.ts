// RFC-338 D5 / AC-2 — owner adapters expose bounded, replay-safe slices so
// foreground writers get a lock handoff between maintenance batches.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInMemoryDb, openDb, type DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  employeeInputUploads,
  memoryDistillEvents,
  memoryDistillJobs,
  missionInputUploads,
  nodeRunEvents,
  nodeRuns,
  tasks,
  tokenAudit,
  tokenDeleteSnapshot,
  webhookDeliveries,
  workflows,
} from '@/db/schema'
import { createEmployeeInputUploadStore } from '@/modules/digital-employee/infrastructure/inputUploadStore'
import { createSqliteUploadSessionStore } from '@/modules/development-automation/infrastructure/sqliteUploadSessionStore'
import { createSqliteActionTemplateStore } from '@/modules/development-automation/infrastructure/sqliteConfigResourceStore'
import { createSqliteWebhookDeliveryPersistence } from '@/modules/integration/infrastructure/sqliteWebhookDeliveryPersistence'
import { composeIntegrationMaintenanceCommands } from '@/modules/integration/composition/maintenance'
import { createSqliteTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createSqliteTaskArchiveMaintenanceCommand } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import { createSqliteTokenCallAudit } from '@/auth/composition'
import { createEventsArchiveMaintenanceCommand } from '@/platform/background/eventsArchiveMaintenance'
import { runMaintenanceJob } from '@/platform/background/maintenanceJobRunner'
import { createSqliteEventsArchiveStore } from '@/platform/persistence/sqlite/systemEventsArchive'
import { runRetentionSweepSlice } from '@/services/maintenanceRetention'
import { pruneTokenAuditSlice } from '@/services/tokenAudit'
import { gcDeliveriesSlice } from '@/services/webhook/deliveryStore'
import { MIGRATIONS } from './migration-freeze'

const unusedOwnerCommands = (db: DbClient, appHome = '/provider-owned/application-home') => ({
  workspace: {
    runGcPhase: async () => ({ scanned: 0, removed: 0, skipped: 0 }),
    recover: async () => ({ completed: 0, failed: 0, skipped: 0 }),
  },
  developmentAutomation: {
    sweepExpiredUploads: async () => 0,
    sweepRetention: async () => ({
      missionsScanned: 0,
      prunedAttempts: 0,
      markedBundleRefs: 0,
      expiredBundleRefsPending: 0,
    }),
  },
  digitalEmployee: { sweepExpiredInputUploads: async () => 0 },
  intent: {
    scratch: { sweep: async () => ({ removed: 0 }) },
    recovery: {
      bootTurnIds: async () => [],
      recover: async () => ({
        failed: 0,
        rolledForward: 0,
        queuedWorkingSets: 0,
        orphanedTurns: 0,
        queuedSessionIds: [],
      }),
    },
  },
  pluginGenerationGc: {
    command: { run: async () => ({ removedGenerationPaths: [] }) },
    executionFence: async () => 'clear' as const,
  },
  integration: composeIntegrationMaintenanceCommands(createSqliteWebhookDeliveryPersistence(db)),
  taskRecovery: createSqliteTaskExecutionPersistence(db).recoveryAdministration,
  taskArchive: createSqliteTaskArchiveMaintenanceCommand(db),
  tokenAudit: createSqliteTokenCallAudit(db),
  system: {
    eventsArchive: createEventsArchiveMaintenanceCommand({
      store: createSqliteEventsArchiveStore(db),
      logsDir: join(appHome, 'logs'),
    }),
    retention: {
      runSlice: async () => ({ counters: {}, delta: { kind: 'none' as const } }),
    },
    storage: { run: async () => ({}) },
  },
})

describe('RFC-338 bounded maintenance owner slices', () => {
  test('plugin generation GC receives the selected command and active-node fence', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const received: Array<{ readonly executionFence: 'clear' | 'busy' }> = []
    const ownerCommands = unusedOwnerCommands(db)
    const result = await runMaintenanceJob({
      appHome: '/provider-owned/application-home',
      ownerCommands: {
        ...ownerCommands,
        pluginGenerationGc: {
          executionFence: async () => 'busy',
          command: {
            async run(input) {
              received.push({ executionFence: input.executionFence })
              return { removedGenerationPaths: [] }
            },
          },
        },
      },
      job: 'pluginGenerationGc',
      payload: {},
    })

    expect(received).toEqual([{ executionFence: 'busy' }])
    expect(result).toEqual({ counters: { removed: 0 }, delta: { kind: 'none' } })
  })

  test('event archive counts a large id space in durable primary-key windows', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'rfc338-event-count-'))
    try {
      await db.insert(workflows).values({
        id: 'event-count-workflow',
        name: 'event-count-workflow',
        definition: '{"nodes":[],"edges":[],"inputs":[]}',
      })
      await db.insert(tasks).values({
        id: 'event-count-task',
        name: 'event-count-task',
        workflowId: 'event-count-workflow',
        workflowSnapshot: '{}',
        repoPath: '/repo',
        worktreePath: '/worktree',
        baseBranch: 'main',
        branch: 'task/event-count',
        status: 'done',
        inputs: '{}',
        startedAt: 1,
        finishedAt: 2,
      })
      await db.insert(nodeRuns).values({
        id: 'event-count-run',
        taskId: 'event-count-task',
        nodeId: 'node',
        status: 'done',
      })
      await db.insert(nodeRunEvents).values([
        { id: 1, nodeRunId: 'event-count-run', ts: 1, kind: 'text', payload: 'first' },
        {
          id: 250_001,
          nodeRunId: 'event-count-run',
          ts: 2,
          kind: 'text',
          payload: 'last',
        },
      ])
      const payload = {
        eventsArchiveThresholds: {
          perNodeRunRows: 10,
          globalRows: 10,
          perNodeRunBytes: 0,
          globalBytes: 0,
        },
      }

      const first = await runMaintenanceJob({
        appHome,
        ownerCommands: unusedOwnerCommands(db, appHome),
        job: 'eventsArchive',
        payload,
      })
      expect(first).toMatchObject({
        counters: { countedRows: 1 },
        continuation: {
          cursor: {
            version: 1,
            phase: 'count',
            maxId: 250_001,
            scanFrom: 250_000,
            totalRows: 1,
          },
        },
      })

      const second = await runMaintenanceJob({
        appHome,
        ownerCommands: unusedOwnerCommands(db, appHome),
        job: 'eventsArchive',
        payload,
        cursor: first.continuation!.cursor,
      })
      expect(second).toMatchObject({
        counters: { perGroupArchived: 0, globalArchived: 0, files: 0 },
        delta: { kind: 'none' },
      })
      expect(second.continuation).toBeUndefined()
      expect(await db.select().from(nodeRunEvents)).toHaveLength(2)
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('Worker-only SQLite observers cover statements and explicit transaction critical sections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc338-db-timings-'))
    const dbPath = join(root, 'db.sqlite')
    const statements: number[] = []
    const transactions: number[] = []
    const db = openDb({
      path: dbPath,
      migrationsFolder: MIGRATIONS,
      skipIntegrityCheck: true,
      slowQueryMs: 0,
      observeStatementMs: (ms) => statements.push(ms),
      observeTransactionMs: (ms) => transactions.push(ms),
    })
    try {
      await db.insert(tokenAudit).values({
        id: 'timed-audit',
        patId: 'pat',
        userId: 'user',
        channel: 'rest',
        statusCode: 200,
        createdAt: 1,
      })
      dbTxSync(db, (tx) => {
        tx.delete(tokenAudit).run()
      })
      expect(statements.length).toBeGreaterThanOrEqual(2)
      expect(statements.every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true)
      expect(transactions).toHaveLength(1)
      expect(transactions[0]).toBeGreaterThanOrEqual(0)
    } finally {
      ;(db as unknown as { $client: { close(): void } }).$client.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('secondary maintenance connections open while a WAL writer is active', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc338-secondary-open-'))
    const dbPath = join(root, 'db.sqlite')
    const primary = openDb({
      path: dbPath,
      migrationsFolder: MIGRATIONS,
      skipIntegrityCheck: true,
      slowQueryMs: 0,
    })
    const sqlite = (primary as unknown as { $client: { exec(sql: string): void; close(): void } })
      .$client
    let secondary: ReturnType<typeof openDb> | undefined
    let inTransaction = false
    try {
      sqlite.exec('BEGIN IMMEDIATE')
      inTransaction = true
      secondary = openDb({
        path: dbPath,
        migrationsFolder: MIGRATIONS,
        skipMigrations: true,
        skipIntegrityCheck: true,
        journalMode: 'preserve',
        busyTimeoutMs: 0,
        slowQueryMs: 0,
      })
      expect(secondary.select().from(tokenAudit).all()).toEqual([])
    } finally {
      if (inTransaction) sqlite.exec('ROLLBACK')
      ;(secondary as unknown as { $client?: { close(): void } } | undefined)?.$client?.close()
      sqlite.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('token audit advances a versioned phase cursor and deletes at most one batch', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const old = 1_000
    await db.insert(tokenAudit).values(
      Array.from({ length: 3 }, (_, index) => ({
        id: `audit-${index}`,
        patId: 'pat',
        userId: 'user',
        channel: 'rest',
        statusCode: 200,
        createdAt: old,
      })),
    )
    await db.insert(tokenDeleteSnapshot).values(
      Array.from({ length: 3 }, (_, index) => ({
        id: `snapshot-${index}`,
        auditId: `audit-${index}`,
        resourceKind: 'task',
        resourceId: String(index),
        snapshotJson: '{}',
        createdAt: old,
      })),
    )

    const first = await pruneTokenAuditSlice(db, 1, null, 100_000_000, 2)
    expect(first).toEqual({
      done: false,
      cursor: { version: 1, phase: 'snapshots', cutoff: 13_600_000 },
      counters: { audits: 0, snapshots: 2 },
    })
    expect((await db.select().from(tokenDeleteSnapshot)).length).toBe(1)

    const second = await pruneTokenAuditSlice(db, 1, first.cursor, 100_000_000, 2)
    expect(second).toEqual({
      done: false,
      cursor: { version: 1, phase: 'audits', cutoff: 13_600_000 },
      counters: { audits: 0, snapshots: 1 },
    })
    const third = await pruneTokenAuditSlice(db, 1, second.cursor, 100_000_000, 2)
    expect(third).toMatchObject({
      done: false,
      cursor: { version: 1, phase: 'audits', cutoff: 13_600_000 },
      counters: { audits: 2, snapshots: 0 },
    })
    const fourth = await pruneTokenAuditSlice(db, 1, third.cursor, 100_000_000, 2)
    expect(fourth).toMatchObject({ done: true, counters: { audits: 1, snapshots: 0 } })
    expect(await db.select().from(tokenAudit)).toHaveLength(0)
  })

  test('token audit rejects an unknown durable cursor version without deleting rows', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await expect(pruneTokenAuditSlice(db, 90, { version: 2, phase: 'audits' })).rejects.toThrow(
      'maintenance-token-audit-cursor-invalid',
    )
  })

  test('webhook delivery GC releases the write lock between bounded body and row batches', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(webhookDeliveries).values(
      Array.from({ length: 3 }, (_, index) => ({
        id: `delivery-${index}`,
        endpointId: 'endpoint',
        status: 'matched' as const,
        bodyJson: '{}',
        receivedAt: 1,
      })),
    )
    const retention = { bodyRetentionMs: 10, rowRetentionMs: 20 }
    const persistence = createSqliteWebhookDeliveryPersistence(db)
    const first = await gcDeliveriesSlice(persistence, 100, retention, null, 2)
    expect(first).toMatchObject({
      done: false,
      cursor: { version: 1, phase: 'bodies', bodyCutoff: 90, rowCutoff: 80 },
      counters: { bodiesCleared: 2, rowsDeleted: 0 },
    })
    const second = await gcDeliveriesSlice(persistence, 100, retention, first.cursor, 2)
    expect(second).toMatchObject({
      done: false,
      cursor: { version: 1, phase: 'rows' },
      counters: { bodiesCleared: 1, rowsDeleted: 0 },
    })
    const third = await gcDeliveriesSlice(persistence, 100, retention, second.cursor, 2)
    expect(third).toMatchObject({
      done: false,
      counters: { bodiesCleared: 0, rowsDeleted: 2 },
    })
    const fourth = await gcDeliveriesSlice(persistence, 100, retention, third.cursor, 2)
    expect(fourth).toMatchObject({
      done: true,
      counters: { bodiesCleared: 0, rowsDeleted: 1 },
    })
    expect(await db.select().from(webhookDeliveries)).toHaveLength(0)
  })

  test('retention sweep persists its table phase between bounded predicate-rechecking deletes', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(memoryDistillJobs).values({
      id: 'distill-job',
      debounceKey: 'key',
      sourceKind: 'review',
      sourceEventId: 'source',
      scopeResolvedJson: '{}',
      status: 'done',
      nextRunAt: 1,
      createdAt: 1,
    })
    await db.insert(memoryDistillEvents).values(
      [1, 2, 3, 99_000_000].map((ts) => ({
        distillJobId: 'distill-job',
        attemptIndex: 0,
        sessionId: 'session',
        ts,
        kind: 'text',
        payload: 'x',
      })),
    )
    const config = { eventStreamRetentionDays: 1, webhookTriggerFiresRetentionDays: 0 }
    const first = await runRetentionSweepSlice(db, config, null, 100_000_000, 2)
    expect(first).toMatchObject({
      done: false,
      cursor: { version: 1, phase: 'distill-events', eventCutoff: 13_600_000 },
      counters: { distillEvents: 2 },
    })
    const second = await runRetentionSweepSlice(db, config, first.cursor, 100_000_000, 2)
    expect(second).toMatchObject({
      done: false,
      cursor: { version: 1, phase: 'intent-turn-events' },
      counters: { distillEvents: 1 },
    })
    expect(await db.select().from(memoryDistillEvents)).toHaveLength(1)
  })

  test('temporary upload owners delete only one bounded batch per maintenance slice', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const development = createSqliteUploadSessionStore(db)
    const employee = createEmployeeInputUploadStore(db)
    for (let index = 0; index < 3; index += 1) {
      development.createUpload({
        actorUserId: null,
        originalName: `development-${index}.txt`,
        bytes: 1,
        sha256: `development-${index}`,
        blobRef: `blob-development-${index}`,
        idempotencyKey: null,
        now: 0,
      })
      employee.create({
        actorUserId: null,
        originalName: `employee-${index}.txt`,
        bytes: 1,
        sha256: `employee-${index}`,
        blobRef: `blob-employee-${index}`,
        idempotencyKey: null,
        now: 0,
      })
    }

    expect(development.sweepExpired(Number.MAX_SAFE_INTEGER, 2)).toBe(2)
    expect(employee.sweepExpired(Number.MAX_SAFE_INTEGER, 2)).toBe(2)
    expect(db.select().from(missionInputUploads).all()).toHaveLength(1)
    expect(db.select().from(employeeInputUploads).all()).toHaveLength(1)

    expect(development.sweepExpired(Number.MAX_SAFE_INTEGER, 2)).toBe(1)
    expect(employee.sweepExpired(Number.MAX_SAFE_INTEGER, 2)).toBe(1)
    expect(db.select().from(missionInputUploads).all()).toHaveLength(0)
    expect(db.select().from(employeeInputUploads).all()).toHaveLength(0)
  })

  test('a contended Worker write yields quickly while the foreground writer keeps ownership', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc338-contention-'))
    const dbPath = join(root, 'db.sqlite')
    const primary = openDb({
      path: dbPath,
      migrationsFolder: MIGRATIONS,
      skipIntegrityCheck: true,
      slowQueryMs: 0,
    })
    await primary.insert(tokenAudit).values({
      id: 'expired-audit',
      patId: 'pat',
      userId: 'user',
      channel: 'rest',
      statusCode: 200,
      createdAt: 1,
    })
    const worker = new Worker(
      new URL('./fixtures/rfc338-maintenance-contention-worker.ts', import.meta.url).href,
    )
    const nextMessage = (): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => resolve(event.data)
        worker.onerror = (event) => reject(new Error(event.message))
      })
    const sqlite = (primary as unknown as { $client: { exec(sql: string): void; close(): void } })
      .$client
    let inTransaction = false
    try {
      const ready = nextMessage()
      worker.postMessage({ type: 'init', dbPath, migrationsFolder: MIGRATIONS })
      expect(await ready).toMatchObject({ type: 'ready' })

      sqlite.exec('BEGIN IMMEDIATE')
      inTransaction = true
      const contended = nextMessage()
      worker.postMessage({
        type: 'slice',
        cursor: { version: 1, phase: 'audits', cutoff: 10_000 },
      })
      // This write uses the request-serving connection while the maintenance
      // Worker is independently waiting on its short busy timeout.
      await primary.insert(tokenAudit).values({
        id: 'foreground-write',
        patId: 'pat',
        userId: 'user',
        channel: 'rest',
        statusCode: 201,
        createdAt: 100_000,
      })
      const failed = await contended
      expect(failed).toMatchObject({ type: 'result', ok: false })
      expect(String(failed.error).toLowerCase()).toMatch(/busy|locked/)
      expect(Number(failed.elapsedMs)).toBeLessThan(500)

      sqlite.exec('COMMIT')
      inTransaction = false
      const retry = nextMessage()
      worker.postMessage({
        type: 'slice',
        cursor: { version: 1, phase: 'audits', cutoff: 10_000 },
      })
      expect(await retry).toMatchObject({
        type: 'result',
        ok: true,
        result: { done: true, counters: { audits: 1, snapshots: 0 } },
      })
      expect(await primary.select().from(tokenAudit)).toMatchObject([{ id: 'foreground-write' }])
    } finally {
      if (inTransaction) sqlite.exec('ROLLBACK')
      worker.terminate()
      sqlite.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('foreground dbTxSync waits at BEGIN IMMEDIATE instead of failing a read-snapshot upgrade', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc338-foreground-contention-'))
    const dbPath = join(root, 'db.sqlite')
    const primary = openDb({
      path: dbPath,
      migrationsFolder: MIGRATIONS,
      skipIntegrityCheck: true,
      slowQueryMs: 0,
      busyTimeoutMs: 1_000,
    })
    await primary.insert(tokenAudit).values({
      id: 'foreground-race',
      patId: 'pat',
      userId: 'user',
      channel: 'rest',
      statusCode: 200,
      createdAt: 1,
    })
    const worker = new Worker(
      new URL('./fixtures/rfc338-foreground-contention-worker.ts', import.meta.url).href,
    )
    const nextMessage = (): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => resolve(event.data)
        worker.onerror = (event) => reject(new Error(event.message))
      })
    try {
      const locked = nextMessage()
      worker.postMessage({ dbPath })
      expect(await locked).toEqual({ type: 'locked' })
      const released = nextMessage()
      const startedAt = performance.now()
      expect(() =>
        dbTxSync(primary, (tx) => {
          expect(tx.select().from(tokenAudit).get()?.statusCode).toBe(201)
          tx.update(tokenAudit).set({ statusCode: 202 }).run()
        }),
      ).not.toThrow()
      expect(performance.now() - startedAt).toBeLessThan(1_000)
      expect(await released).toEqual({ type: 'released' })
      expect((await primary.select().from(tokenAudit))[0]?.statusCode).toBe(202)
    } finally {
      worker.terminate()
      ;(primary as unknown as { $client: { close(): void } }).$client.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('config resource publish waits at BEGIN IMMEDIATE instead of returning a transient 500', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc338-config-publish-contention-'))
    const dbPath = join(root, 'db.sqlite')
    const primary = openDb({
      path: dbPath,
      migrationsFolder: MIGRATIONS,
      skipIntegrityCheck: true,
      slowQueryMs: 0,
      busyTimeoutMs: 1_000,
    })
    await primary.insert(tokenAudit).values({
      id: 'foreground-race',
      patId: 'pat',
      userId: 'user',
      channel: 'rest',
      statusCode: 200,
      createdAt: 1,
    })
    const store = createSqliteActionTemplateStore(primary)
    store.create({
      id: 'action-template-race',
      name: 'Action template race',
      draftJson: '{}',
      ownerUserId: 'user',
      now: 1,
      extra: { capabilityId: 'change.implement' },
    })
    const worker = new Worker(
      new URL('./fixtures/rfc338-foreground-contention-worker.ts', import.meta.url).href,
    )
    const nextMessage = (): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => resolve(event.data)
        worker.onerror = (event) => reject(new Error(event.message))
      })
    try {
      const locked = nextMessage()
      worker.postMessage({ dbPath })
      expect(await locked).toEqual({ type: 'locked' })
      const released = nextMessage()
      expect(() =>
        store.publishRevision({
          resourceId: 'action-template-race',
          revision: 1,
          contentJson: '{}',
          contentDigest: 'sha256:action-template-race',
          publishedAt: 2,
          publishedBy: 'user',
        }),
      ).not.toThrow()
      expect(await released).toEqual({ type: 'released' })
      expect(store.getRevision('action-template-race', 1)).toMatchObject({
        revision: 1,
        contentDigest: 'sha256:action-template-race',
      })
    } finally {
      worker.terminate()
      ;(primary as unknown as { $client: { close(): void } }).$client.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
