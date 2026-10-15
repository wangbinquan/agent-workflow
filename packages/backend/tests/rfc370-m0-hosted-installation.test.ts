// RFC-370 M0 — the database installation of a CrewStation-hosted instance
// (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §5.1).
// Locks: the generation identity is derived from the platform service and
// carries no SQLite migration manifest; the installation port exposes no
// SQLite→PostgreSQL migration capabilities; a serving instance only verifies
// the schema; a fresh database receives exactly the rows a freshly migrated
// SQLite source would hold, once; and Settings live in the database with the
// deployment-owned database connection refused in patches.
import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type DatabaseConfig } from '@agent-workflow/shared'
import { getTableName, isTable } from 'drizzle-orm'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import * as schema from '@/db/schema'
import { applicationConfiguration, authLoginPolicy } from '@/db/schema'
import {
  createHostedDatabaseInstallation,
  HostedDatabaseInstallationError,
} from '@/modules/system-operations/infrastructure/crewstation/hostedDatabaseInstallation'
import { createDatabaseApplicationConfiguration } from '@/modules/system-operations/infrastructure/databaseApplicationConfiguration'
import { prepareHostedPostgresqlProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import { hostedDatabaseGeneration } from '@/platform/persistence/generationValidation'
import {
  orderSeedTables,
  seedHostedInstallation,
} from '@/platform/persistence/hostedInstallationSeed'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { describeEachProvider } from './helpers/eachProvider'
import { MIGRATIONS } from './migration-freeze'

const contract = buildLogicalSchemaContract()

test('the hosted generation is derived from the platform service, without a migration manifest', () => {
  const first = hostedDatabaseGeneration({
    project: 'agent-workflow',
    service: 'agent-workflow',
    schemaDigest: contract.digest,
  })
  const again = hostedDatabaseGeneration({
    project: 'agent-workflow',
    service: 'agent-workflow',
    schemaDigest: contract.digest,
  })
  const other = hostedDatabaseGeneration({
    project: 'agent-workflow',
    service: 'other',
    schemaDigest: contract.digest,
  })
  expect(first).toEqual(again)
  expect(first.source).toBe('hosted-installation')
  expect(first.payload).toMatchObject({
    provider: 'postgresql',
    operationId: null,
    manifestDigest: null,
    schemaDigest: contract.digest,
  })
  expect(first.payload.generationId).toMatch(/^dbg_cs_[0-9a-f]{32}$/)
  expect(other.payload.generationId).not.toBe(first.payload.generationId)
})

test('the hosted installation port has no SQLite migration capabilities', async () => {
  const prepared = { kind: 'prepared' } as never
  const requests: unknown[] = []
  const installation = createHostedDatabaseInstallation({
    project: 'p',
    service: 's',
    prepare: async (request) => {
      requests.push(request)
      return prepared
    },
  })
  const candidate = await installation.readGeneration({ contract })
  expect(candidate).toMatchObject({
    kind: 'current',
    generation: { source: 'hosted-installation' },
  })
  expect(await installation.listMigrations()).toEqual([])
  for (const call of [
    () => installation.readMigration('dbm_x'),
    () => installation.writeGeneration({} as never),
    () => installation.resolveRecoverySource({ fromContractDigest: 'a', toContractDigest: 'b' }),
    () => installation.resumeMigration({} as never),
  ]) {
    expect(call).toThrow(HostedDatabaseInstallationError)
  }
  const config = { provider: 'postgresql' } as DatabaseConfig
  expect(
    await installation.prepareProvider({
      config,
      contract,
      candidate,
      requireUpgradeLock: async () => {},
      advancePointer: async () => {},
    }),
  ).toBe(prepared)
  expect(requests).toEqual([
    { config, contract, generation: candidate.kind === 'current' ? candidate.generation : null },
  ])
  await expect(
    installation.prepareProvider({
      config,
      contract,
      candidate: { kind: 'schema-upgrade', payload: {} as never, pointerDigest: 'x' },
      requireUpgradeLock: async () => {},
      advancePointer: async () => {},
    }),
  ).rejects.toThrow(HostedDatabaseInstallationError)
})

test('seed tables are ordered parents first and a cycle is refused', () => {
  const ordered = orderSeedTables([
    { name: 'child', references: ['parent'] },
    { name: 'parent', references: ['grandparent', 'parent'] },
    { name: 'grandparent', references: ['outside'] },
  ])
  expect(ordered.map((table) => table.name)).toEqual(['grandparent', 'parent', 'child'])
  expect(() =>
    orderSeedTables([
      { name: 'a', references: ['b'] },
      { name: 'b', references: ['a'] },
    ]),
  ).toThrow('foreign-key cycle')
})

function allTables(): { name: string; table: SQLiteTable; references: string[] }[] {
  return Object.values(schema)
    .filter((candidate) => isTable(candidate))
    .map((candidate) => {
      const table = candidate as SQLiteTable
      return {
        name: getTableName(table),
        table,
        references: getTableConfig(table).foreignKeys.map((fk) =>
          getTableName(fk.reference().foreignTable),
        ),
      }
    })
}

describeEachProvider('RFC-370 M0 hosted installation rows and Settings document', (harness) => {
  async function countRows(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {}
    for (const entry of allTables()) {
      const rows = await harness.db.select().from(entry.table)
      if (rows.length > 0) counts[entry.name] = rows.length
    }
    return counts
  }

  test('a fresh database receives the migrated SQLite seed rows once', async () => {
    const reference = await countRows()
    expect(reference.auth_login_policy).toBe(1)
    for (const entry of orderSeedTables(allTables()).reverse()) {
      await harness.db.delete(entry.table)
    }
    expect(await countRows()).toEqual({})
    const receipt = await seedHostedInstallation({
      target: harness.db,
      migrationsFolder: MIGRATIONS,
      now: 42,
    })
    expect(receipt.seeded).toBe(true)
    expect(await countRows()).toEqual(reference)
    const policy = (await harness.db.select().from(authLoginPolicy))[0]!
    expect(policy.bootstrapCompletedAt).toBe(42)
    expect(
      await seedHostedInstallation({ target: harness.db, migrationsFolder: MIGRATIONS, now: 99 }),
    ).toEqual({ seeded: false, tables: 0, rows: 0 })
  }, 60_000)

  test('Settings live in the database and the deployment owns the database connection', async () => {
    const managed = { provider: 'postgresql', urlEnv: 'CS_DATABASE_URL' } as DatabaseConfig
    const settings = createDatabaseApplicationConfiguration({
      db: harness.db,
      managed: { database: managed },
      now: () => 7,
    })
    const initial = await settings.load()
    expect(initial).toEqual({ ...DEFAULT_CONFIG, database: managed })
    expect(await harness.db.select().from(applicationConfiguration)).toEqual([])

    const next = await settings.applyPatch({ language: 'en-US' })
    expect(next).toMatchObject({ language: 'en-US', database: managed })
    expect(await settings.load()).toEqual(next)
    const stored = (await harness.db.select().from(applicationConfiguration))[0]!
    expect(stored).toMatchObject({ id: 'global', revision: 1, updatedAt: 7 })
    expect(JSON.parse(stored.document)).not.toHaveProperty('database')
    await settings.applyPatch({ language: 'zh-CN' })
    expect((await harness.db.select().from(applicationConfiguration))[0]!.revision).toBe(2)

    for (const attempt of [
      () => settings.previewPatch({ database: { provider: 'sqlite' } }),
      () => settings.applyPatch({ database: { provider: 'sqlite' } }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'setting-managed-by-deployment' })
    }
    expect((await settings.load()).language).toBe('zh-CN')
  })

  test('a serving instance verifies the current schema and names the hosted generation', async () => {
    if (harness.applicationBinding.provider !== 'postgresql') return
    const generation = hostedDatabaseGeneration({
      project: 'agent-workflow',
      service: 'agent-workflow',
      schemaDigest: contract.digest,
    })
    const prepared = await prepareHostedPostgresqlProviderRuntime({
      config: harness.applicationBinding.databaseConfig,
      contract,
      generation,
      history: await loadPostgresqlMigrationHistory(),
      schema: 'verify',
    })
    try {
      expect(prepared.receipt.applied).toBe(false)
      expect(prepared.runtime.generation).toEqual(generation)
      expect(prepared.describeSchemaOutcome()).toContain(
        `PostgreSQL schema verified (generation: ${generation.payload.generationId}`,
      )
    } finally {
      await prepared.runtime.close()
    }
  }, 60_000)
})
