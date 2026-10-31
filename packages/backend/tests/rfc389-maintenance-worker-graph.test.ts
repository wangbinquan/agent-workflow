// RFC-389 — exercise the one passive Worker graph on both real database providers.
// Locks owner keys, selected storage/archive operations, observers and connection lifetime.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeMaintenanceWorkerGraph } from '@/bootstrap/maintenanceWorkerGraph'
import { MAINTENANCE_CATALOG_DIGEST } from '@/platform/background/maintenanceCatalog'
import { MAINTENANCE_PROTOCOL_VERSION } from '@/platform/background/maintenanceProtocol'
import type { MaintenanceWorkerEffectsSelections } from '@/bootstrap/maintenanceWorkerEffects'
import type { MaintenanceWorkerGraphFactory } from '@/platform/background/maintenanceWorkerRuntime'
import { createMaintenanceRunStore } from '@/platform/persistence/maintenanceRunStore'
import { describeEachProvider, type ProviderDatabaseHarness } from './helpers/eachProvider'
import { openProviderMaintenanceWorkerDatabase } from './helpers/providerMaintenanceWorker'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createContentStore,
  createObjectContentTransport,
} from '@/platform/content/infrastructure/contentStore'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import { objectFixture } from './helpers/rfc370Objects'

type MaintenanceWorkerGraph = Awaited<ReturnType<typeof composeMaintenanceWorkerGraph>>

type GraphInput = Parameters<MaintenanceWorkerGraphFactory<MaintenanceWorkerEffectsSelections>>[0]
async function fixture(
  harness: ProviderDatabaseHarness,
  body: (input: {
    readonly db: PersistenceDb
    compose(effects?: MaintenanceWorkerEffectsSelections): Promise<MaintenanceWorkerGraph>
    close(): Promise<void>
    readonly mainStore: ReturnType<typeof createMaintenanceRunStore>
    readonly statements: Array<{ ms: number; sql: string | undefined; cpuMs: number | undefined }>
    readonly transactions: number[]
    readonly request: GraphInput['request']
  }) => Promise<void>,
): Promise<void> {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc389-worker-graph-'))
  const database = openProviderMaintenanceWorkerDatabase(harness, appHome)
  const statements: Array<{ ms: number; sql: string | undefined; cpuMs: number | undefined }> = []
  const transactions: number[] = []
  const closes: Array<() => Promise<void>> = []
  const request: GraphInput['request'] = {
    ...database.databaseInit,
    type: 'init',
    version: MAINTENANCE_PROTOCOL_VERSION,
    catalogDigest: MAINTENANCE_CATALOG_DIGEST,
    appHome,
  }
  try {
    await body({
      db: database.db,
      async compose(effects) {
        const graph = await composeMaintenanceWorkerGraph({
          request,
          appHome,
          effects,
          observe: {
            statement: (ms, sql, cpuMs) => {
              statements.push({ ms, sql, cpuMs })
            },
            transaction: (ms) => {
              transactions.push(ms)
            },
          },
          registerConnectionClose: (close) => {
            closes.push(close)
          },
        })
        expect(closes).toHaveLength(1)
        expect(graph.close).toBe(closes[0]!)
        return graph
      },
      async close() {
        await closes.shift()!()
      },
      mainStore: createMaintenanceRunStore(database.db),
      statements,
      transactions,
      request,
    })
  } finally {
    for (const close of closes) await close()
    await database.dispose()
    rmSync(appHome, { recursive: true, force: true })
  }
}

describeEachProvider('RFC-389 neutral maintenance Worker graph', (harness) => {
  test('AF-D14 the hosted graph leaves uncommitted object publications for the hosted sweep', async () => {
    await fixture(harness, async ({ compose, db }) => {
      const objects = objectFixture()
      const content = createContentStore({
        db,
        objectPublicationEpoch: () => 1,
        policy: { inlineMaxBytes: 0, externalKind: 'object' },
        transports: { object: createObjectContentTransport(objects.objects) },
      })
      const bytes = Buffer.from('hosted failed owner')
      const publication = {
        owner: 'task-execution',
        logicalKey: 'hosted-upload',
        scope: null,
        attempt: 'attempt-1',
        epoch: 1,
        sha256: sha256Hex(bytes),
        size: bytes.length,
      }
      await expect(
        content.put(
          {
            publication,
            source: { kind: 'bytes', bytes },
            contentVersion: 1,
            mediaType: null,
            references: 'single',
          },
          async () => {
            throw new Error('owner-commit-failed')
          },
        ),
      ).rejects.toThrow('owner-commit-failed')
      await databaseSessionFor(db).transaction((tx) =>
        content.publications.release(
          tx,
          { owner: publication.owner, keys: [publication.logicalKey] },
          1,
        ),
      )
      const before = await content.publications.find(publication)
      expect(before).toMatchObject({ state: 'releasing', contentId: null })
      const graph = await compose({ contentStore: content })
      await graph.ownerCommands.system.storage.run()
      expect(await content.publications.find(publication)).toEqual(before)
    })
  })
  test('one passive graph preserves owner keys and does not recover/admit jobs during construction', async () => {
    await fixture(harness, async ({ compose, mainStore, request }) => {
      await mainStore.enqueue({
        id: 'passive',
        jobKey: 'walCheckpoint',
        jobClass: 'checkpoint',
        slotKey: 'passive',
        payload: {},
        scheduledAt: 1,
        now: 1,
      })
      await mainStore.claimNext({ leaseToken: 'original-lease', now: 2, leaseMs: 100 })
      const graph = await compose()
      expect(Object.keys(graph.ownerCommands).sort()).toEqual([
        'atomicApply',
        'developmentAutomation',
        'digitalEmployee',
        'integration',
        'intent',
        'pluginGenerationGc',
        'system',
        'taskArchive',
        'taskRecovery',
        'tokenAudit',
        'workspace',
      ])
      expect(await mainStore.read('passive')).toMatchObject({
        state: 'running',
        leaseToken: 'original-lease',
        attempt: 1,
      })
      expect(graph.busyDeferralCounter).toBe(
        'database' in request ? 'postgresqlTransientDeferrals' : 'sqliteBusyDeferrals',
      )
      expect(graph.ownerCommands.system.objectPublications).toBeUndefined()
      expect(graph.ownerCommands.system.databaseBackups).toBeUndefined()
    })
  })

  test('selected archive, retention and storage commands retain their provider receipts', async () => {
    await fixture(harness, async ({ compose, request }) => {
      const graph = await compose()
      expect(
        await graph.ownerCommands.system.eventsArchive.runSlice({
          thresholds: {
            perNodeRunRows: 100,
            globalRows: 100,
            perNodeRunBytes: 100_000,
            globalBytes: 100_000,
          },
        }),
      ).toEqual({
        counters: { perGroupArchived: 0, globalArchived: 0, files: 0 },
        delta: { kind: 'none' },
      })
      expect(
        await graph.ownerCommands.system.retention.runSlice({
          eventStreamRetentionDays: 0,
          webhookTriggerFiresRetentionDays: 0,
        }),
      ).toEqual({
        counters: {
          distillEvents: 0,
          intentTurnEvents: 0,
          mcpRuntimeTestEvents: 0,
          webhookTriggerFires: 0,
          userAccessAudit: 0,
        },
        delta: { kind: 'none' },
      })
      const storage = await graph.ownerCommands.system.storage.run()
      if ('database' in request) {
        expect(Object.keys(storage).sort()).toEqual([
          'autoanalyzeRuns',
          'autovacuumRuns',
          'deadRows',
          'protected',
          'purged',
          'released',
        ])
        for (const value of Object.values(storage)) expect(value).toBeGreaterThanOrEqual(0)
      } else expect(storage).toEqual({ checkpointed: 1, released: 0, purged: 0, protected: 0 })
    })
  })

  test('both providers pass selected backup/publication commands unchanged without calling them', async () => {
    await fixture(harness, async ({ compose }) => {
      const calls: string[] = []
      const databaseBackups = {
        async prune() {
          calls.push('backup')
          return { deleted: 2, kept: 3 }
        },
      }
      const objectPublications = {
        async run() {
          calls.push('publication')
          return { released: 4 }
        },
      }
      const graph = await compose({ databaseBackups, objectPublications })
      expect(calls).toEqual([])
      expect(graph.ownerCommands.system.databaseBackups).toBe(databaseBackups)
      expect(graph.ownerCommands.system.objectPublications).toBe(objectPublications)
      expect(
        await graph.ownerCommands.system.databaseBackups!.prune({
          retentionCount: 3,
          retentionDays: 1,
        }),
      ).toEqual({ deleted: 2, kept: 3 })
      expect(await graph.ownerCommands.system.objectPublications!.run()).toEqual({ released: 4 })
      expect(calls).toEqual(['backup', 'publication'])
    })
  })

  test('SQLite observers receive real statement/transaction timings and close releases only the Worker connection', async () => {
    await fixture(
      harness,
      async ({ compose, close, mainStore, request, statements, transactions }) => {
        const graph = await compose()
        statements.length = 0
        transactions.length = 0
        await graph.store.enqueue({
          id: 'observed',
          jobKey: 'walCheckpoint',
          jobClass: 'checkpoint',
          slotKey: 'observed',
          payload: {},
          scheduledAt: 1,
          now: 1,
        })
        if ('database' in request) {
          expect(statements).toEqual([])
          expect(transactions).toEqual([])
        } else {
          expect(statements.length).toBeGreaterThan(0)
          expect(statements.some(({ sql }) => sql?.includes('maintenance_runs'))).toBe(true)
          expect(statements.every(({ ms }) => Number.isFinite(ms) && ms >= 0)).toBe(true)
          expect(transactions.length).toBeGreaterThan(0)
          expect(transactions.every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true)
        }
        await close()
        await expect(graph.store.read('observed')).rejects.toThrow()
        expect(await mainStore.read('observed')).toMatchObject({ state: 'pending', attempt: 0 })
      },
    )
  })
})
