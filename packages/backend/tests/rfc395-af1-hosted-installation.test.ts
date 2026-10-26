import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeEachProvider } from './helpers/eachProvider'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import {
  prepareHostedPostgresqlProviderRuntime,
  prepareEpoch2DatabaseProviderRuntime,
} from '@/platform/persistence/databaseProviderRuntime'
import { hostedDatabaseGeneration } from '@/platform/persistence/generationValidation'
import { readGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { seedHostedInstallation } from '@/platform/persistence/hostedInstallationSeed'
import { digestSchemaContract } from '@/platform/persistence/schema/canonical'
import { tablesOf } from '@/platform/persistence/sessionTables'

describeEachProvider('AF-D3/D4/D6 hosted native generation selection', (h) => {
  for (const role of ['converted', 'restored'] as const)
    test(`${role} targets retain their active generation at serving and release migrate`, async () => {
      const b = h.applicationBinding
      if (b.provider !== 'postgresql') return
      await h.executeFixtureDdl(`UPDATE agent_workflow_meta.generations SET role='${role}'`)
      const pool = b.runtime.providerPool()
      const generation = hostedDatabaseGeneration({
        project: 'same-project',
        service: 'same-service',
        schemaDigest: logicalSchemaContract.digest,
      })
      // Conversion retains the epoch-1 installation id as a lineage reference;
      // the old generation need not itself be a live epoch-2 generation row.
      await pool.unsafe('UPDATE agent_workflow_meta.generations SET source_generation_id=$1', [
        generation.payload.generationId,
      ])
      for (const schema of ['verify', 'apply'] as const) {
        const prepared = await prepareHostedPostgresqlProviderRuntime({
          config: b.databaseConfig,
          contract: logicalSchemaContract,
          generation,
          schema,
          postgresqlPoolFactory: () => ({ ...pool, async close() {} }),
        })
        try {
          expect(prepared.runtime.generation.payload.generationId).toBe(b.runtime.generationId)
          expect(prepared.runtime.runtime.generationId).toBe(b.runtime.generationId)
          expect(prepared.describeSchemaOutcome()).toBe(
            `PostgreSQL schema verified (generation: ${b.runtime.generationId}, active tables: ${logicalSchemaContract.activeTableCount})\n`,
          )
          const identities = await pool.unsafe(
            "SELECT record_json FROM agent_workflow_meta.migration_records WHERE run_id=$1 AND unit_id='hosted-installation-identity'",
            [b.runtime.generationId],
          )
          expect(identities).toHaveLength(schema === 'verify' ? 0 : 1)
          if (schema === 'apply')
            expect(JSON.parse(String(identities[0]!.record_json))).toEqual(generation.identity)
          expect(
            await seedHostedInstallation({
              contract: logicalSchemaContract,
              target: prepared.openBootstrapClient(),
              now: 10,
              installed: prepared.receipt.installedSeeds,
            }),
          ).toEqual({ seeded: false, tables: 0, rows: 0 })
          expect(
            (
              await pool.unsafe('SELECT first_live_write_at FROM agent_workflow_meta.first_write')
            )[0]!.first_live_write_at,
          ).toBeNull()
        } finally {
          await prepared.runtime.close()
        }
      }
      for (const schema of ['verify', 'apply'] as const)
        await expect(
          prepareHostedPostgresqlProviderRuntime({
            config: b.databaseConfig,
            contract: logicalSchemaContract,
            generation: hostedDatabaseGeneration({
              project: 'other-project',
              service: 'same-service',
              schemaDigest: logicalSchemaContract.digest,
            }),
            schema,
            postgresqlPoolFactory: () => ({ ...pool, async close() {} }),
          }),
        ).rejects.toThrow('postgresql-generation-conflict')
    })
  test('fresh hosted seeds finish bootstrap without a business write and report the actual installation', async () => {
    const b = h.applicationBinding
    if (b.provider !== 'postgresql') return
    const pool = b.runtime.providerPool()
    await pool.unsafe('DROP SCHEMA agent_workflow CASCADE')
    await pool.unsafe('DROP SCHEMA agent_workflow_meta CASCADE')
    const platformIdentity = {
      CS_DATABASE_GENERATION_ID: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      CS_DATABASE_GENERATION_OPERATION: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
    }
    const generation = hostedDatabaseGeneration({
      project: 'fresh',
      service: 'fresh',
      schemaDigest: logicalSchemaContract.digest,
      env: platformIdentity,
    })
    const prepared = await prepareHostedPostgresqlProviderRuntime({
      config: b.databaseConfig,
      contract: logicalSchemaContract,
      generation,
      schema: 'apply',
      postgresqlPoolFactory: () => ({ ...pool, async close() {} }),
    })
    try {
      expect(prepared.runtime.runtime.generationId).toBe(generation.payload.generationId)
      const db = prepared.openBootstrapClient(),
        { authLoginPolicy } = tablesOf(db)
      expect((await db.select().from(authLoginPolicy))[0]!.bootstrapCompletedAt).not.toBeNull()
      const receipt = await seedHostedInstallation({
        contract: logicalSchemaContract,
        target: db,
        now: 10,
        installed: prepared.receipt.installedSeeds,
      })
      expect(receipt.seeded).toBeTrue()
      expect(receipt.rows).toBeGreaterThan(0)
      expect(receipt.tables).toBeGreaterThan(0)
      expect(
        (await pool.unsafe('SELECT first_live_write_at FROM agent_workflow_meta.first_write'))[0]!
          .first_live_write_at,
      ).toBeNull()
      const identity = await pool.unsafe(
        "SELECT record_json, record_digest FROM agent_workflow_meta.migration_records WHERE run_id=$1 AND unit_id='hosted-installation-identity'",
        [generation.payload.generationId],
      )
      expect(JSON.parse(String(identity[0]!.record_json))).toEqual(generation.identity)
      expect(identity[0]!.record_digest).toBe(digestSchemaContract(generation.identity))
      for (const schema of ['verify', 'apply'] as const) {
        for (const changed of [
          { project: 'other', service: 'fresh', env: platformIdentity },
          { project: 'fresh', service: 'other', env: platformIdentity },
          { project: 'fresh', service: 'fresh' },
          {
            project: 'fresh',
            service: 'fresh',
            env: {
              ...platformIdentity,
              CS_DATABASE_GENERATION_ID: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
            },
          },
          {
            project: 'fresh',
            service: 'fresh',
            env: {
              ...platformIdentity,
              CS_DATABASE_GENERATION_OPERATION: 'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
            },
          },
        ]) {
          await expect(
            prepareHostedPostgresqlProviderRuntime({
              config: b.databaseConfig,
              contract: logicalSchemaContract,
              generation: hostedDatabaseGeneration({
                ...changed,
                schemaDigest: logicalSchemaContract.digest,
              }),
              schema,
              postgresqlPoolFactory: () => ({ ...pool, async close() {} }),
            }),
          ).rejects.toThrow('postgresql-generation-conflict')
        }
      }
      expect(
        await pool.unsafe(
          "SELECT record_json, record_digest FROM agent_workflow_meta.migration_records WHERE run_id=$1 AND unit_id='hosted-installation-identity'",
          [generation.payload.generationId],
        ),
      ).toEqual(identity)
      await db.update(authLoginPolicy).set({ updatedAt: 11 })
      expect(
        (await pool.unsafe('SELECT first_live_write_at FROM agent_workflow_meta.first_write'))[0]!
          .first_live_write_at,
      ).not.toBeNull()
    } finally {
      await prepared.runtime.close()
    }
  })
  test('an unpublished PostgreSQL installed head is adopted once and a written head is refused', async () => {
    const b = h.applicationBinding
    if (b.provider !== 'postgresql') return
    const home = mkdtempSync(join(tmpdir(), 'af1-pg-adopt-'))
    const pool = b.runtime.providerPool()
    const options = {
      config: b.databaseConfig,
      contract: logicalSchemaContract,
      sqlitePath: join(home, 'db.sqlite'),
      generationPointerPath: join(home, 'database-generation.json'),
      operationsRoot: join(home, 'database-migrations'),
      sqliteOptions: {},
      postgresqlPoolFactory: () => ({ ...pool, async close() {} }),
    }
    try {
      const prepared = await prepareEpoch2DatabaseProviderRuntime(options)
      expect(prepared.runtime.generation.payload.generationId).toBe(b.runtime.generationId)
      expect(readGenerationPointerV2(options.generationPointerPath).payload.generationId).toBe(
        b.runtime.generationId,
      )
      await prepared.runtime.close()
      rmSync(options.generationPointerPath)
      await pool.unsafe('UPDATE agent_workflow_meta.first_write SET first_live_write_at=123')
      await expect(prepareEpoch2DatabaseProviderRuntime(options)).rejects.toThrow(
        'epoch2-unpublished-installation-not-adoptable',
      )
      expect(existsSync(options.generationPointerPath)).toBeFalse()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
