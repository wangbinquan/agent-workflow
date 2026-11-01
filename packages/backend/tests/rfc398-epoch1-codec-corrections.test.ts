// RFC-398 T13 regression (L2 v0.19.2 PostgreSQL, design §11): v0.18.18–v0.19.2 grant
// `users:presence` to every regular user, while their contracts (before PostgreSQL 0038 /
// SQLite 0262) label user_permission_grants.permission as JSON. The candidate decoded such a
// source with that historical label and refused every installation that had a regular user
// ("logical database codec rejected invalid JSON at user_permission_grants.permission").
// Readers now apply the frozen history's V9 codec corrections; the contract itself is unchanged.
import { expect, test } from 'bun:test'
import {
  loadSupportedSourceManifest,
  withLogicalCodecCorrections,
} from '@/platform/persistence/migration/supportedSources'
import type { LogicalTableContract } from '@/platform/persistence/schema/contractTypes'
import { describeV1Providers, type V1Harness } from './helpers/rfc395V1Harness'
import { resolvePostgresqlTestUrlEnv } from './helpers/eachProvider'
import {
  upgradeEpoch1Copy,
  type OfflinePostgresqlDatabase,
} from '@/platform/persistence/migration/offlineSourceUpgrade'
import type { Epoch1SqliteSource } from '@/platform/persistence/migration/sqliteSourceReader'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'

const correction = {
  tableId: 'user_permission_grants',
  column: 'permission',
  before: 'json-text',
  after: 'text-identity',
} as const

test('the manifest carries the frozen V9 correction and relabels only the matching codec', async () => {
  const manifest = await loadSupportedSourceManifest()
  expect(manifest.codecCorrections).toContainEqual(correction)
  const grants = {
    id: 'user_permission_grants',
    columns: [
      { name: 'user_id', logicalCodec: 'text-identity' },
      { name: 'permission', logicalCodec: 'json-text' },
    ],
  } as unknown as LogicalTableContract
  const corrected = withLogicalCodecCorrections(grants, manifest.codecCorrections)
  expect(corrected.columns.map((column) => column.logicalCodec)).toEqual([
    'text-identity',
    'text-identity',
  ])
  // The frozen contract object is never mutated (its digest still identifies the source).
  expect(grants.columns[1]!.logicalCodec).toBe('json-text')
  // A real JSON column of the same name elsewhere keeps its codec.
  const agents = {
    id: 'agents',
    columns: [{ name: 'permission', logicalCodec: 'json-text' }],
  } as unknown as LogicalTableContract
  expect(withLogicalCodecCorrections(agents, manifest.codecCorrections)).toBe(agents)
})

describeV1Providers('RFC-398 epoch-1 codec corrections', (h) => {
  test('a pre-correction source reads plain permission keys instead of refusing them', async () => {
    const version = await h.install('pre-seq')
    const grants = version.contract.tables.find((table) => table.id === 'user_permission_grants')!
    expect(grants.columns.find((column) => column.name === 'permission')!.logicalCodec).toBe(
      'json-text',
    )
    const users = version.contract.tables.find((table) => table.id === 'users')!
    const row = frozenValues('users', { id: 'rfc398-regular', username: 'rfc398-regular' })
    const columns = users.columns.map((column) => column.name).filter((name) => name in row)
    const placeholder = (index: number) => (h.provider === 'sqlite' ? '?' : `$${index + 1}`)
    await h.native.execute(
      `INSERT INTO ${h.table('users')} (${columns.map((name) => `"${name}"`).join(',')}) VALUES (${columns.map((_, i) => placeholder(i)).join(',')})`,
      columns.map((name) => {
        const value = row[name]
        return h.provider === 'sqlite' && typeof value === 'boolean' ? Number(value) : value
      }),
    )
    await h.native.execute(
      `INSERT INTO ${h.table('user_permission_grants')} (user_id, permission, granted_by_user_id, granted_at) VALUES (${[0, 1, 2, 3].map(placeholder).join(',')})`,
      ['rfc398-regular', 'users:presence', null, 123],
    )
    const source = await h.source()
    const expected = await source.preflight()
    const chunk = await source.readChunk('user_permission_grants', null, 10)
    expect(chunk.decodedRows).toEqual([
      expect.objectContaining({ user_id: 'rfc398-regular', permission: 'users:presence' }),
    ])
    // The offline copy (PostgreSQL scratch copy and SQLite file copy) re-verifies every copied
    // row with the same corrected codec before replaying 0038 / 0262 to the head contract.
    const manifest = await h.manifest()
    const copy =
      h.provider === 'sqlite'
        ? await upgradeEpoch1Copy({
            source: source as Epoch1SqliteSource,
            expected,
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
      const reader = copy.reader
      expect((await reader.preflight()).contract?.digest).toBe(manifest.headDigest)
      expect((await reader.readChunk('user_permission_grants', null, 10)).decodedRows).toEqual([
        expect.objectContaining({ permission: 'users:presence' }),
      ])
    } finally {
      await copy.close()
    }
  }, 300_000)
})

async function createOffline(h: V1Harness): Promise<OfflinePostgresqlDatabase> {
  const name = `rfc398_codec_${crypto.randomUUID().replaceAll('-', '')}`
  const url = new URL(process.env[resolvePostgresqlTestUrlEnv(process.env)!]!)
  url.pathname = `/${name}`
  await h.pool.unsafe(`CREATE DATABASE "${name}"`)
  const runtime = createPostgresqlDatabaseRuntime({
    generationId: 'dbg_rfc398_codec_offline',
    config: PostgresqlDatabaseConfigSchema.parse({
      provider: 'postgresql',
      urlEnv: 'RFC398_CODEC_OFFLINE_URL',
    }),
    env: { RFC398_CODEC_OFFLINE_URL: url.toString() },
  })
  return {
    runtime,
    async close() {
      await runtime.close()
      await h.pool.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
    },
  }
}
