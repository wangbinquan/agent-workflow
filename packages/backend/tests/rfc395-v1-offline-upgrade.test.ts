// RFC-395 V1: upgrades are bound to a freeze, preserve retired rows, and expose offline readers.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describeV1Providers, installFrozenSqlite, type V1Harness } from './helpers/rfc395V1Harness'
import { resolvePostgresqlTestUrlEnv } from './helpers/eachProvider'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import {
  upgradeEpoch1Copy,
  type OfflinePostgresqlDatabase,
} from '@/platform/persistence/migration/offlineSourceUpgrade'
import { openEpoch1SqliteSource } from '@/platform/persistence/migration/sqliteSourceReader'
import { sourceFilesDigest } from '@/platform/persistence/migration/sourceReader'
import { SourceBlockedError } from '@/platform/persistence/migration/sourceTypes'

async function createOffline(h: V1Harness): Promise<OfflinePostgresqlDatabase> {
  const name = `v1_offline_${crypto.randomUUID().replaceAll('-', '')}`
  const url = new URL(process.env[resolvePostgresqlTestUrlEnv(process.env)!]!)
  url.pathname = `/${name}`
  await h.pool.unsafe(`CREATE DATABASE "${name}"`)
  const runtime = createPostgresqlDatabaseRuntime({
    generationId: 'dbg_rfc395_v1_offline',
    config: {
      provider: 'postgresql',
      urlEnv: 'V1_OFFLINE_URL',
      poolMax: 2,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 120_000,
      idleTimeoutMs: 120_000,
    },
    env: { V1_OFFLINE_URL: url.toString() },
  })
  return {
    runtime,
    async close() {
      await runtime.close()
      await h.pool.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
    },
  }
}
describeV1Providers('RFC-395 V1 offline source upgrade', (h) => {
  for (const from of ['pre-seq', 'root'] as const)
    test(`${from}: offline upgrade reaches head and has a usable reader without changing source`, async () => {
      await h.install(from)
      await h.seed()
      const manifest = await h.manifest()
      const source = await h.source()
      const before = await source.preflight()
      try {
        const copy =
          h.provider === 'sqlite'
            ? await upgradeEpoch1Copy({
                source: source as ReturnType<typeof openEpoch1SqliteSource>,
                expected: before,
                manifest,
                operationRoot: h.operationRoot,
              })
            : await upgradeEpoch1Copy({
                source,
                manifest,
                operationRoot: h.operationRoot,
                createEmptyDatabase: () => createOffline(h),
              })
        try {
          const after = await copy.reader.preflight()
          expect(after.contract?.digest).toBe(manifest.headDigest)
          expect(copy.sourceWatermark).toBe(before.watermark)
          expect(copy.sourcePreflight).toEqual(before)
          expect(copy.sourcePreflight.identityHighWater).toEqual(before.identityHighWater)
          expect(
            (await copy.reader.readChunk('maintenance_state', null, 10)).decodedRows.map(
              (row) => row.key,
            ),
          ).toEqual(['v1-a', 'v1-z', 'v1-é'])
          expect((await source.preflight()).watermark).toBe(before.watermark)
          if (h.provider === 'postgresql' && from === 'root') {
            const history = await loadFrozenEpoch1History()
            expect(after.sourceVersion).toBe(
              `postgresql:${history.postgresql.versions.length - 1}:baseline:0`,
            )
            expect(after.fingerprint.journalEntryCount).toBe(history.postgresql.versions.length)
          }
        } finally {
          await copy.close()
        }
      } finally {
        await source.close()
      }
    }, 300_000)
  if (h.provider === 'sqlite') {
    for (const through of [1, 120, 223])
      test(`published SQLite prefix ${through} identifies and upgrades on a copy`, async () => {
        await installFrozenSqlite(h.sqlite, through)
        const manifest = await h.manifest()
        const source = openEpoch1SqliteSource({
          path: h.sqlitePath,
          manifest,
          operationRoot: h.operationRoot,
        })
        const expected = await source.preflight()
        expect(expected.requiresOfflineUpgrade).toBe(true)
        expect(expected.contract).toBeNull()
        await expect(source.readChunk('agents', null, 1)).rejects.toBeInstanceOf(SourceBlockedError)
        const copy = await upgradeEpoch1Copy({
          source,
          expected,
          manifest,
          operationRoot: h.operationRoot,
        })
        try {
          expect((await copy.reader.preflight()).contract?.digest).toBe(manifest.headDigest)
          await source.assertUnchanged(expected)
        } finally {
          await copy.close()
          await source.close()
        }
      }, 300_000)
    test('a non-empty retired table is captured raw before the chain drops it', async () => {
      await installFrozenSqlite(h.sqlite, 1)
      h.sqlite.exec("INSERT INTO recent_repos VALUES ('retired',9007199254740993,NULL)")
      const source = openEpoch1SqliteSource({
        path: h.sqlitePath,
        manifest: await h.manifest(),
        operationRoot: h.operationRoot,
      })
      const expected = await source.preflight()
      expect(expected.tables.find((table) => table.table === 'recent_repos')?.disposition).toBe(
        'archived',
      )
      const original = await source.readRawChunk('recent_repos', null, 1)
      expect(original.rows[0]?.cells.last_used_at).toEqual({
        storageClass: 'integer',
        value: { type: 'integer', value: '9007199254740993' },
      })
      const copy = await upgradeEpoch1Copy({
        source,
        expected,
        manifest: await h.manifest(),
        operationRoot: h.operationRoot,
      })
      try {
        expect(copy.after.tableRows.recent_repos).toBeUndefined()
        const archive = copy.sourceEvidence.find((entry) => entry.table.table === 'recent_repos')!
        expect(archive.rows).toBe(1)
        expect(JSON.parse(readFileSync(archive.chunks[0]!.path, 'utf8')).sourceDigest).toBe(
          original.sourceDigest,
        )
        expect(await source.readRawChunk('recent_repos', null, 1)).toEqual(original)
      } finally {
        await copy.close()
        await source.close()
      }
    }, 300_000)
    test('upgrades accept schema-bound empty-table decisions and reject a changed watermark', async () => {
      await h.install('pre-seq')
      h.sqlite.exec('CREATE TABLE v1_empty (id TEXT PRIMARY KEY)')
      const { tableCatalogDigest } =
        await import('@/platform/persistence/migration/sourceDispositions')
      const fingerprint = await h.fingerprint()
      const emptyTables = [
        {
          table: 'v1_empty',
          catalogDigest: tableCatalogDigest(fingerprint, 'v1_empty'),
          disposition: 'archived' as const,
          reason: 'approved empty schema evidence',
        },
      ]
      const manifest = await h.manifest()
      const source = openEpoch1SqliteSource({
        path: h.sqlitePath,
        manifest,
        operationRoot: h.operationRoot,
        emptyTables,
      })
      const expected = await source.preflight()
      try {
        const copy = await upgradeEpoch1Copy({
          source,
          expected,
          manifest,
          operationRoot: h.operationRoot,
          emptyTables,
        })
        expect(copy.after.tableRows.v1_empty).toBe(0)
        await copy.close()
        await expect(
          upgradeEpoch1Copy({
            source,
            expected: { ...expected, watermark: 'changed' },
            manifest,
            operationRoot: h.operationRoot,
            emptyTables,
          }),
        ).rejects.toBeInstanceOf(SourceBlockedError)
        const wrongHead = upgradeEpoch1Copy({
          source,
          expected,
          manifest: { ...manifest, headDigest: 'changed' },
          operationRoot: h.operationRoot,
          emptyTables,
        })
        await expect(wrongHead).rejects.toBeInstanceOf(SourceBlockedError)
        await expect(wrongHead).rejects.toThrow('did not reach the frozen head')
      } finally {
        await source.close()
      }
    }, 300_000)
  }
  if (h.provider === 'postgresql') {
    test('cross-provider upgrade reads an actual SQLite file and loads PostgreSQL', async () => {
      const history = await loadFrozenEpoch1History()
      const root = mkdtempSync(join(h.operationRoot, 'sqlite-to-pg-'))
      const path = join(root, 'original.sqlite')
      // SQLite VACUUM/file mechanics are intrinsic to this cross-provider source fixture.
      const database = new Database(path)
      await installFrozenSqlite(database, history.postgresql.root.sqliteMigrations.length)
      database.exec(
        "DELETE FROM maintenance_state; INSERT INTO maintenance_state VALUES ('v1-cross','original bytes',123)",
      )
      database.close()
      const before = await sourceFilesDigest(path)
      const manifest = await h.manifest()
      const source = openEpoch1SqliteSource({ path, manifest, operationRoot: root })
      try {
        const copy = await upgradeEpoch1Copy({
          source,
          manifest,
          operationRoot: root,
          createEmptyDatabase: () => createOffline(h),
        })
        try {
          expect(
            (await copy.reader.readChunk('maintenance_state', null, 2)).decodedRows[0]?.value,
          ).toBe('original bytes')
          expect(await sourceFilesDigest(path)).toBe(before)
        } finally {
          await copy.close()
        }
      } finally {
        await source.close()
        rmSync(root, { recursive: true, force: true })
      }
    }, 300_000)
    test('an offline target containing an application schema is rejected with a typed error', async () => {
      await h.install()
      const source = await h.source()
      try {
        await expect(
          upgradeEpoch1Copy({
            source,
            manifest: await h.manifest(),
            operationRoot: h.operationRoot,
            async createEmptyDatabase() {
              return { runtime: h.runtime, async close() {} }
            },
          }),
        ).rejects.toBeInstanceOf(SourceBlockedError)
      } finally {
        await source.close()
      }
    }, 300_000)
  }
})
