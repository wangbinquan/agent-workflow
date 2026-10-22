// RFC-370 M0 — the database installation of a CrewStation-hosted instance
// (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §5.1).
// Locks: the generation identity is derived from the platform service and
// names the installation copy as its operation, like every PostgreSQL
// generation; the installation port exposes no SQLite→PostgreSQL migration
// capabilities; a fresh database receives exactly the rows a freshly migrated
// SQLite source would hold, once (on PostgreSQL without the archive-only
// tables); and Settings live in the database with the deployment-owned
// database connection refused in patches. The migration Job → serving instance
// cycle on a real PostgreSQL is rfc370-m0-hosted-postgresql.integration.test.ts.
import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type DatabaseConfig } from '@agent-workflow/shared'
import type { Table } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import {
  createHostedDatabaseInstallation,
  HostedDatabaseInstallationError,
} from '@/modules/system-operations/infrastructure/crewstation/hostedDatabaseInstallation'
import { createDatabaseApplicationConfiguration } from '@/modules/system-operations/infrastructure/databaseApplicationConfiguration'
import {
  DatabaseGenerationPayloadSchema,
  hostedDatabaseGeneration,
} from '@/platform/persistence/generationValidation'
import {
  orderSeedTables,
  seedHostedInstallation,
} from '@/platform/persistence/hostedInstallationSeed'
import { buildLogicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { describeEachProvider } from './helpers/eachProvider'
import { MIGRATIONS } from './migration-freeze'

const contract = buildLogicalSchemaContract()

test('the hosted generation is derived from the platform service and names its installation copy', () => {
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
  expect(first.payload).toMatchObject({ provider: 'postgresql', schemaDigest: contract.digest })
  expect(first.payload.generationId).toMatch(/^dbg_cs_[0-9a-f]{32}$/)
  // The same identity names the release migration Job's installation copy.
  expect(first.payload.operationId).toBe(first.payload.generationId.replace('dbg_cs_', 'dbm_cs_'))
  expect(first.payload.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  // A PostgreSQL generation must reference its operation (DatabaseGenerationPayloadSchema).
  expect(DatabaseGenerationPayloadSchema.parse(first.payload)).toEqual(first.payload)
  expect(other.payload.generationId).not.toBe(first.payload.generationId)
  expect(other.payload.operationId).not.toBe(first.payload.operationId)
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
  // No local migration record exists: the generation's operation is the Job's
  // installation copy, recorded in PostgreSQL itself.
  expect(await installation.listMigrations()).toEqual([])
  expect(await installation.readMigration('dbm_x')).toBeNull()
  for (const call of [
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

/** Tables that exist on PostgreSQL: archive-only tables are never created there. */
const POSTGRESQL_TABLES = new Set(
  contract.tables.flatMap((table) =>
    table.providerTables.postgresql === undefined ? [] : [table.sourceTable],
  ),
)

function allTables(
  db: object,
  provider: 'sqlite' | 'postgresql',
): { name: string; table: Table; references: string[] }[] {
  const tables = tablesOf(db)
  return persistenceSchema.tables
    .map((definition) => ({
      name: definition.id,
      table: tables[definition.schemaSymbol],
      references: definition.foreignKeys.map((key) => key.foreignTable),
    }))
    .filter((entry) => provider === 'sqlite' || POSTGRESQL_TABLES.has(entry.name))
}

describeEachProvider('RFC-370 M0 hosted installation rows and Settings document', (harness) => {
  async function countRows(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {}
    for (const entry of allTables(harness.db, harness.applicationBinding.provider)) {
      const rows = await harness.db.select().from(entry.table)
      if (rows.length > 0) counts[entry.name] = rows.length
    }
    return counts
  }

  test('a fresh database receives the migrated SQLite seed rows once', async () => {
    const reference = await countRows()
    expect(reference.auth_login_policy).toBe(1)
    for (const entry of orderSeedTables(
      allTables(harness.db, harness.applicationBinding.provider),
    ).reverse()) {
      await harness.db.delete(entry.table)
    }
    expect(await countRows()).toEqual({})
    const receipt = await seedHostedInstallation({
      contract: buildLogicalSchemaContract(),
      target: harness.db,
      migrationsFolder: MIGRATIONS,
      now: 42,
    })
    expect(receipt.seeded).toBe(true)
    expect(await countRows()).toEqual(reference)
    const { authLoginPolicy } = tablesOf(harness.db)
    const policy = (await harness.db.select().from(authLoginPolicy))[0]!
    expect(policy.bootstrapCompletedAt).toBe(42)
    expect(
      await seedHostedInstallation({
        contract: buildLogicalSchemaContract(),
        target: harness.db,
        migrationsFolder: MIGRATIONS,
        now: 99,
      }),
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
    const { applicationConfiguration } = tablesOf(harness.db)
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
})
