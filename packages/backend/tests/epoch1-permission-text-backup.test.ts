import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { migratePostgresqlSchema } from '@/platform/persistence/migration/legacy/postgresqlMigrator'
import { installFrozenSqlite } from './helpers/rfc395V1Harness'
// AF-D21: live epoch-2 backup/restore, plus a released epoch-1 artifact as converter input.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeEachProvider } from './helpers/eachProvider'
import { describeV3Providers } from './helpers/rfc395V3Harness'
import { seedFrozenPostgresqlSource } from './helpers/rfc395V3/sourceSeeds'
import { integrationInput } from './helpers/rfc395V2/integration'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { openFrozenSource } from '@/platform/persistence/migration/freeze/sourceAccess'
import { unpackOldEpochBackup } from '@/platform/persistence/migration/freeze/oldEpochBackup'
import { createBackup } from '@/services/backup'
import { restoreBackup } from '@/platform/persistence/sqlite/systemProviderRestore'
import { createPostgresqlProviderBackup } from '@/modules/system-operations/infrastructure/postgresqlProviderBackup'
import { restorePostgresqlProviderBackup } from '@/modules/system-operations/infrastructure/postgresqlProviderRestore'
import { createPortableBackupApplicationAssets } from '@/platform/persistence/portableApplicationAssets'
import { createPostgresqlProviderRestoreApplicationAssets } from '@/modules/system-operations/infrastructure/postgresqlProviderRestoreApplicationAssets'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import { writeGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { openDb } from '@/db/client'

// Frozen backup conversion and reopen take about 18 s per CI-scaled case; allow 60 s.
setDefaultTimeout(60_000)

const permission = 'users:presence'
describeEachProvider(
  'AF-D21 native permission-text backup and restore',
  (h) => {
    test('roundtrips a non-JSON permission through the live provider archive', async () => {
      const home = mkdtempSync(join(tmpdir(), 'native-permission-'))
      try {
        const { users, userPermissionGrants } = tablesOf(h.db)
        await insertOne(h.db, users, {
          id: 'permission-user',
          username: 'permission-user',
          displayName: 'Permission user',
          role: 'user',
          createdAt: 1,
          updatedAt: 1,
        })
        await insertOne(h.db, userPermissionGrants, {
          userId: 'permission-user',
          permission,
          grantedAt: 1,
        })
        const source = h.applicationBinding
        if (source.provider === 'sqlite') {
          const backup = await createBackup({
            contract: logicalSchemaContract,
            db: source.db,
            appHome: home,
          })
          const appHome = join(home, 'restored'),
            dbPath = join(appHome, 'db.sqlite')
          await restoreBackup(backup.path, {
            contract: logicalSchemaContract,
            appHome,
            dbPath,
            noSafetyBackup: true,
          })
          const restored = openDb({ path: dbPath })
          try {
            expect(
              restored.$client.query('SELECT permission FROM user_permission_grants').all(),
            ).toEqual([{ permission }])
          } finally {
            restored.$client.close()
          }
        } else {
          const head = persistenceHead()
          writeGenerationPointerV2({
            pointerPath: join(home, 'database-generation.json'),
            payload: {
              version: 2,
              schemaEpoch: 2,
              generationId: source.runtime.generationId,
              provider: 'postgresql',
              role: 'installed',
              database: {
                kind: 'postgresql-target',
                profileRef: `env:${source.databaseConfig.urlEnv}`,
              },
              contractDigest: head.contract.contract.digest,
              planDigest: head.postgresql.digest,
              operationId: null,
              manifestDigest: null,
              activatedAt: 1,
              previous: null,
            },
          })
          const backup = await createPostgresqlProviderBackup({
            headContract: logicalSchemaContract,
            contract: logicalSchemaContract,
            runtime: source.runtime,
            application: createPortableBackupApplicationAssets({ db: h.db }),
            appHome: home,
          })
          const target = h.database(1).applicationBinding
          if (target.provider !== 'postgresql') throw new Error('target provider mismatch')
          await h.database(1).executeFixtureDdl('DROP SCHEMA agent_workflow CASCADE')
          await h.database(1).executeFixtureDdl('DROP SCHEMA agent_workflow_meta CASCADE')
          const generationId = 'dbg_permission_restored'
          const runtime = { ...target.runtime, generationId }
          const db = createPostgresqlDatabaseClient(runtime)
          const appHome = join(home, 'restored')
          mkdirSync(appHome)
          await restorePostgresqlProviderBackup({
            headContract: logicalSchemaContract,
            contract: logicalSchemaContract,
            plan: buildPostgresqlSchemaPlan(logicalSchemaContract),
            runtime,
            targetGenerationId: generationId,
            tarballPath: backup.path,
            appHome,
            restoreOperationId: 'dbm_permission_restored',
            filesystem: createPostgresqlProviderRestoreApplicationAssets({
              db,
              appHome,
              databaseConfig: target.databaseConfig,
            }),
          })
          expect(
            await runtime
              .providerPool()
              .unsafe('SELECT permission FROM agent_workflow.user_permission_grants'),
          ).toEqual([{ permission }])
        }
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  },
  { databaseCount: 2 },
)

describeV3Providers('AF-D21 permission-text epoch-1 artifact conversion', (v3) => {
  const h = v3.source
  async function timed<T>(format: string, stage: string, body: () => Promise<T>): Promise<T> {
    const started = performance.now()
    try {
      return await body()
    } finally {
      console.info(
        'permission-backup-timing',
        JSON.stringify({
          provider: h.sourceHarness.provider,
          format,
          stage,
          milliseconds: Math.round(performance.now() - started),
        }),
      )
    }
  }
  for (const format of ['text', 'v8-json'] as const)
    test(`BF-D20 converts a real released ${format} permission backup with its stored text unchanged`, async () => {
      // The physical PG reference must still be empty. The v8 fixture installs
      // its version directly, so random order must not rely on the text case
      // having warmed the manifest through h.install() first.
      await h.sourceHarness.manifest()
      const history = await loadFrozenEpoch1History()
      const version =
        format === 'text'
          ? await timed(format, 'install', () => h.install())
          : history.postgresql.versions.at(-2)!
      if (format === 'v8-json') {
        if (h.sourceHarness.provider === 'sqlite')
          await installFrozenSqlite(h.sourceHarness.sqlite, version.sqliteMigrations.length)
        else
          await migratePostgresqlSchema({
            runtime: h.sourceHarness.runtime,
            headContract: frozenEpoch1Contract,
            plan: version.plan,
          })
        if (h.sourceHarness.provider === 'postgresql') await seedFrozenPostgresqlSource(h, version)
        expect(
          version.contract.tables
            .find((table) => table.id === 'user_permission_grants')!
            .columns.find((column) => column.name === 'permission')!.logicalCodec,
        ).toBe('json-text')
      }
      const storedPermission = format === 'v8-json' ? JSON.stringify(permission) : permission
      await h.write('users', [
        {
          id: 'permission-user',
          username: 'permission-user',
          display_name: 'Permission user',
          role: 'user',
          created_at: 1,
          updated_at: 1,
        },
      ])
      await h.write('user_permission_grants', [
        { user_id: 'permission-user', permission: storedPermission, granted_at: 1 },
      ])
      const backup = await timed(format, 'export', () => h.sourceHarness.backup(version))
      try {
        // The shared reader fixture also supplies a hosted header; this case is a portable SQLite archive.
        if (h.sourceHarness.provider === 'sqlite') rmSync(join(backup.root, 'hosted-backup.json'))
        const unpacked = await unpackOldEpochBackup({
          artifact: backup.root,
          destination: join(h.sourceHarness.operationRoot, 'permission-unpacked'),
        })
        const scratch = async () => ({ runtime: v3.runtime, async close() {} })
        const request = {
          location: { kind: 'backup' as const, ...unpacked, artifact: backup.root },
          manifest: await h.sourceHarness.manifest(),
          emptyTables: [],
          operationRoot: join(h.sourceHarness.operationRoot, 'permission-convert'),
          ...(h.sourceHarness.provider === 'postgresql'
            ? {
                createScratchPostgresql: scratch,
                reopenScratchPostgresql: scratch,
              }
            : {}),
        }
        let source = await timed(format, 'preflight', () => openFrozenSource(request))
        if (source.preUpgrade) {
          const expected = {
            watermark: source.watermark,
            preUpgradeWatermark: source.preUpgrade.preflight.watermark,
            sourceGenerationId: source.preflight.sourceGenerationId,
          }
          await source.close()
          source = await timed(format, 'reopen', () => openFrozenSource({ ...request, expected }))
          expect(source.preUpgrade).not.toBeNull()
        }
        try {
          const input = await timed(format, 'conversion-input', () =>
            integrationInput(h, {
              source: source.reader,
              ...(source.preUpgrade
                ? {
                    preUpgradeSource: source.preUpgrade.reader,
                    preUpgradePreflight: source.preUpgrade.preflight,
                  }
                : {}),
            }),
          )
          const sink = new V2MemorySink()
          const result = await timed(format, 'conversion', () => runConversion(input, sink))
          expect(result.plan.blocks).toEqual([])
          expect(sink.rows('user_permission_grants')).toContainEqual(
            expect.objectContaining({ user_id: 'permission-user', permission: storedPermission }),
          )
        } finally {
          await source.close()
        }
      } finally {
        backup.close()
        if (h.sourceHarness.provider === 'postgresql')
          await v3.runtime
            .providerPool()
            .unsafe('DROP TABLE IF EXISTS public.aw_epoch1_upgrade_scratch')
      }
    })
})
