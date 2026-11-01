// RFC-398 gate P1-3: S1/S2 can agree while reader AND target corrupt a non-key
// value. Exercise captureSource + the complete S1-S3 oracle with identical keys,
// counts and valid receipts. This behavioural negative uses no DB/guard exemption.
import { expect, test } from 'bun:test'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { encodeLogicalRow } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import type { FrozenSourceHandle } from '@/platform/persistence/migration/run/types'
import type {
  SourcePreflight,
  VersionedSourceReader,
} from '@/platform/persistence/migration/sourceTypes'
import { readRegistry } from '../../../scripts/release-upgrade/lib/io'
import type { BuiltRelease } from './helpers/releaseUpgrade/build'
import { captureSource } from './helpers/releaseUpgrade/source'
import { checkEpoch1 } from './helpers/releaseUpgrade/oracle'
import { keyDigest, logicalKeys, type Row, type Snapshot } from './helpers/releaseUpgrade/data'
import {
  checkSqlGeneratedRelationships,
  normalizeSqlValue,
} from './helpers/releaseUpgrade/sqlNormalization'

const table = frozenEpoch1Contract.tables.find((t) => t.id === 'maintenance_state')!
const seed = { key: 'negative-value', value: 'seed-original', updated_at: 1778459500000 }
function fixture(observed: typeof seed) {
  const before: Snapshot = new Map([[table.id, [seed]]])
  const built: BuiltRelease = {
    release: readRegistry().releases.find((r) => r.tag === 'v0.19.2')!,
    provider: 'sqlite',
    home: '',
    sourcePath: '',
    startedAt: Date.now(),
    env: {},
    seeds: [],
    before,
    async snapshotTarget() {
      throw new Error('in-memory oracle does not open a database')
    },
    async close() {},
  }
  const preflight: SourcePreflight = {
    version: 1,
    kind: 'sqlite-file',
    sourceVersion: 'negative-control',
    contract: frozenEpoch1Contract,
    fingerprint: {
      version: 1,
      provider: 'sqlite',
      evidence: 'physical-catalog-and-journal',
      catalog: [],
      catalogDigest: 'fixture',
      journal: [],
      journalEntryCount: 0,
      tableRows: { [table.id]: 1 },
      digest: 'fixture',
    },
    sourceGenerationId: 'negative-values-generation',
    identityHighWater: [],
    identityEvidence: 'physical',
    watermark: 'fixture',
    requiresOfflineUpgrade: false,
    expectedAbsent: [],
    content: [],
    tables: [
      {
        table: table.id,
        physicalTable: table.id,
        rows: 1,
        disposition: 'preserved',
        reason: 'negative control',
        destination: { kind: 'business', tables: [table.id] },
      },
    ],
  }
  const encoded = encodeLogicalRow(table, observed)
  const reader: VersionedSourceReader = {
    kind: 'sqlite-file',
    async preflight() {
      return preflight
    },
    async assertUnchanged() {},
    async close() {},
    async readChunk(_table, afterKey) {
      return {
        version: 1,
        sourceVersion: preflight.sourceVersion,
        table: table.id,
        migrationKey: table.migrationKey,
        afterKey,
        firstKey: afterKey ? null : encoded.key,
        lastKey: afterKey ? null : encoded.key,
        rows: afterKey ? [] : [encoded],
        decodedRows: afterKey ? [] : [observed],
        sourceDigest: 'fixture',
      }
    },
    async readRawChunk() {
      throw new Error('no raw tables in this negative control')
    },
  }
  const source: FrozenSourceHandle = {
    reader,
    preflight,
    preUpgrade: null,
    watermark: 'fixture',
    evidenceRoot: null,
    close: reader.close,
  }
  const keys = logicalKeys(table, [seed])
  const counts_json = JSON.stringify({ converted: 0, preserved: 1, archived: 0, blocked: 0 })
  const identity = {
    source_table: table.id,
    source_phase: 'current',
    key_digest: keyDigest(keys),
    counts_json,
  }
  const target: Snapshot = new Map<string, Row[]>([
    [table.id, [observed]],
    [
      'aw_meta_migration_records',
      [
        {
          record_json: JSON.stringify({
            kind: 'identity-high-water',
            table: 'node_run_seq_allocations',
            value: 0,
          }),
        },
      ],
    ],
    [
      'aw_meta_migration_unit_sources',
      [
        {
          ...identity,
          unit_id: 'negative-values-unit',
          unit_kind: 'rows',
          rows: 1,
          first_key: keys[0],
          last_key: keys[0],
        },
      ],
    ],
    ['aw_meta_migration_table_receipts', [{ ...identity, rows_read: 1 }]],
  ])
  return { built, source, expected: { rows: before }, target }
}

test('positive control: complete S1-S3 accepts the independently authored seed', async () => {
  const f = fixture(seed)
  const census = await captureSource(f.source, f.built, f.expected)
  await checkEpoch1(f.built, census, f.target)
})
for (const [column, observed] of [
  ['value', { ...seed, value: 'reader-corrupted' }],
  ['updated_at', { ...seed, updated_at: seed.updated_at + 1000 }],
] as const) {
  test(`S3 rejects reader/target collusion on ${column} with unchanged S1/S2`, async () => {
    const f = fixture(observed)
    expect(logicalKeys(table, [observed])).toEqual(logicalKeys(table, [seed]))
    const census = await captureSource(f.source, f.built, f.expected)
    expect(census.current.get(table.id)).toEqual([seed])
    expect(census.tables[0]!.rows).toEqual([seed])
    // Valid S1/S2 receipts and the independent target pass even with a bad reader.
    await checkEpoch1(f.built, census, new Map([...f.target, [table.id, [seed]]]))
    let failure: unknown
    try {
      await checkEpoch1(f.built, census, f.target)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    const errors = (failure as AggregateError).errors as Error[]
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain(`S3 maintenance_state->maintenance_state.${column}`)
  })
}

test('SQL normalization is scoped to pending migrations and validates generated values', () => {
  const { built } = fixture(seed)
  built.release = readRegistry().releases.find((r) => r.tag === 'v0.1.0')!
  const now = Math.floor(Date.now() / 1000) * 1000
  expect(normalizeSqlValue(built, 'auth_login_policy', { id: 'global' }, 'updated_at', now)).toBe(0)
  expect(() =>
    normalizeSqlValue(built, 'auth_login_policy', { id: 'global' }, 'updated_at', seed.updated_at),
  ).toThrow('released SQL timestamp')
  expect(normalizeSqlValue(built, 'maintenance_state', seed, 'updated_at', seed.updated_at)).toBe(
    seed.updated_at,
  )
  expect(
    normalizeSqlValue(built, 'code_host_connections', {}, 'connection_generation', 'a'.repeat(32)),
  ).toBe('0'.repeat(32))
  expect(() =>
    normalizeSqlValue(built, 'code_host_connections', {}, 'connection_generation', 'invalid'),
  ).toThrow('randomblob encoding')
  built.release = readRegistry().releases.find((r) => r.tag === 'v0.19.2')!
  expect(
    normalizeSqlValue(built, 'auth_login_policy', { id: 'global' }, 'updated_at', seed.updated_at),
  ).toBe(seed.updated_at)
  expect(
    normalizeSqlValue(
      built,
      'code_host_connections',
      {},
      'connection_generation',
      'seed-generation',
    ),
  ).toBe('seed-generation')
})

test('normalizing random generations still preserves the SQL copy relationship', () => {
  const snapshot = (connection: string, transport: string): Snapshot =>
    new Map([
      ['code_host_connections', [{ provider: 'github', connection_generation: connection }]],
      [
        'repository_transport_connections',
        [{ provider: 'github', connection_generation: transport }],
      ],
    ])
  const independent = snapshot('a'.repeat(32), 'a'.repeat(32))
  expect(() =>
    checkSqlGeneratedRelationships(independent, snapshot('b'.repeat(32), 'b'.repeat(32))),
  ).not.toThrow()
  expect(() =>
    checkSqlGeneratedRelationships(independent, snapshot('b'.repeat(32), 'c'.repeat(32))),
  ).toThrow('S3 released SQL shared connection generation')
})
