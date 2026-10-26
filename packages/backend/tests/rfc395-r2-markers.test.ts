// RFC-395 II-b R2: real epoch-1 refusal seams and equal first-committed-write markers on both engines.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { assertMigrationHistory, readExpectedMigrationChain } from '@/db/schemaAdmission'
import { openDb } from './helpers/epoch1Protocol/sqliteClient'
import { migratePostgresqlSchema } from '@/platform/persistence/migration/legacy/postgresqlMigrator'
import type { LogicalSchemaContract } from '@/platform/persistence/schema/contractTypes'
import { digestSchemaContract } from '@/platform/persistence/schema/canonical'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/migration/legacy/postgresqlSchema'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import {
  firstLiveWriteAt,
  initializeFirstWriteMarker,
  markFirstLiveWrite,
  installTargetSentinel,
} from '@/platform/persistence/schema/history/markers'
import { describeR2Providers } from './helpers/rfc395R2Harness'
import { r2Registry } from './helpers/rfc395R2Schema'

describeR2Providers('RFC-395 R2 target markers', (h) => {
  test('the real epoch-1 migration/admission path refuses a target database', async () => {
    await h.apply(createHistoryVersion({ registry: r2Registry(), slug: 'baseline' }))
    if (h.provider === 'sqlite') {
      const migrationsFolder = resolve(import.meta.dir, '../db/migrations')
      expect(() =>
        assertMigrationHistory(h.sqlite, {
          dbPath: h.sqlitePath,
          expected: readExpectedMigrationChain(migrationsFolder),
          stage: 'migration-history-preflight',
          allowPrefix: true,
        }),
      ).toThrow('migration-history-preflight')
      expect(() => openDb({ path: h.sqlitePath, migrationsFolder })).toThrow(
        'migration-history-preflight',
      )
    } else {
      const contract = {
        contractVersion: 2,
        sourceProjection: 'sqlite' as const,
        sourceTableCount: 0,
        activeTableCount: 0,
        archiveOnlyTableCount: 0,
        tables: [],
      }
      const headContract: LogicalSchemaContract = {
        ...contract,
        digest: digestSchemaContract(contract),
      }
      await expect(
        migratePostgresqlSchema({
          runtime: h.runtime,
          headContract,
          plan: buildPostgresqlSchemaPlan(headContract),
        }),
      ).rejects.toMatchObject({ code: 'postgresql-schema-partial' })
      await h.pool.unsafe('DROP SCHEMA agent_workflow CASCADE')
      await h.pool.unsafe('DROP SCHEMA agent_workflow_meta CASCADE')
      await installTargetSentinel(h.native)
      const migrate = () =>
        migratePostgresqlSchema({
          runtime: h.runtime,
          headContract,
          plan: buildPostgresqlSchemaPlan(headContract),
        })
      await expect(migrate()).rejects.toMatchObject({ code: 'postgresql-schema-partial' })
      await h.pool.unsafe('DROP TABLE agent_workflow_meta.schema_migrations')
      // Without the sentinel the same otherwise-empty engine is accepted.
      expect(await migrate()).toBeDefined()
      await h.pool.unsafe('DROP SCHEMA agent_workflow CASCADE')
      await h.pool.unsafe('DROP SCHEMA agent_workflow_meta CASCADE')
      await h.apply(createHistoryVersion({ registry: r2Registry(), slug: 'baseline' }))
    }
    expect(await h.native.execute(`SELECT id FROM ${h.table('r2_items')}`)).toEqual([])
  })
  test('read-only work and rollback do not mark; the first committed business write is permanent', async () => {
    await h.apply(createHistoryVersion({ registry: r2Registry(), slug: 'baseline' }))
    const generation = 'dbg_rfc395_firstwrite'
    await initializeFirstWriteMarker(h.native, generation)
    expect(await firstLiveWriteAt(h.native, generation)).toBeNull()
    await h.native.execute(`SELECT id FROM ${h.table('r2_items')}`)
    expect(await firstLiveWriteAt(h.native, generation)).toBeNull()
    await expect(
      h.transaction(async (transaction) => {
        await transaction.execute(`INSERT INTO ${h.table('r2_items')} (id) VALUES ('rolled-back')`)
        await markFirstLiveWrite(transaction, generation, 10)
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await firstLiveWriteAt(h.native, generation)).toBeNull()
    expect(await h.native.execute(`SELECT id FROM ${h.table('r2_items')}`)).toEqual([])
    await h.transaction(async (transaction) => {
      await transaction.execute(`INSERT INTO ${h.table('r2_items')} (id) VALUES ('committed')`)
      await markFirstLiveWrite(transaction, generation, 11)
    })
    await h.transaction(async (transaction) => {
      await markFirstLiveWrite(transaction, generation, 99)
    })
    await initializeFirstWriteMarker(h.native, generation)
    expect(await firstLiveWriteAt(h.native, generation)).toBe(11)
    await expect(firstLiveWriteAt(h.native, 'missing')).rejects.toThrow('marker-missing')
  })
})
