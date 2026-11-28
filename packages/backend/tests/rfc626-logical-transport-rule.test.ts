// RFC-626 §3.3 "PostgreSQL 搬运数据时不检查取值规则": the transport value rule of the logical
// codec, the backup export written under it, the manifest field that records it, and the
// readers that read a backup under the rule it records.
//
// Why these tests exist: the copy into the scratch database, the backup export and reading
// that backup back all went through the strict logical codec, which refuses JSON-text cells
// that are not JSON and reals that are NaN / ±Infinity although the physical PostgreSQL columns
// hold them. Any such value ended the automatic upgrade before the conversion — which sets such
// a row aside — ever saw it. Under the transport rule only those two value rules are relaxed;
// the representation stays the same, so for every row the strict rule accepts the encoded
// values, chunks, digests and backup files must stay byte for byte what they were (the
// property-style cases below), and a manual upgrade keeps the strict rule.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import {
  LogicalDatabaseCodecError,
  createLogicalTableChunk,
  encodeLogicalRow,
  encodeLogicalValue,
  verifyLogicalTableChunk,
  type CanonicalLogicalRow,
  type CanonicalLogicalValue,
  type LogicalValueRule,
} from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import { exportLogicalDatabaseArtifact } from '@/platform/persistence/migration/legacy/logicalDatabaseExport'
import {
  LogicalDatabaseRestoreError,
  openVerifiedLogicalDatabaseArtifactSource,
} from '@/platform/persistence/migration/legacy/logicalDatabaseRestore'
import {
  backupValueRule,
  readManifest,
  writeManifest,
  type BackupManifestV2,
} from '@/platform/persistence/migration/legacy/backupManifest'
import { openEpoch1LogicalArtifactSource } from '@/platform/persistence/migration/artifactSourceReader'
import { SourceBlockedError } from '@/platform/persistence/migration/sourceTypes'
import { canonicalSchemaJson, digestSchemaContract } from '@/platform/persistence/schema/canonical'
import type {
  LogicalColumnContract,
  LogicalTableContract,
} from '@/platform/persistence/schema/contractTypes'

const contract = frozenEpoch1Contract
const runtimes = contract.tables.find((table) => table.id === 'runtimes')!
const column = (name: string) => runtimes.columns.find((entry) => entry.name === name)!
const OPERATION = 'dbm_rfc626_transport_rule'
const GENERATION = 'dbg_rfc626_transport_rule'

/** Deterministic PRNG for the property-style cases. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const TEXT = ['', 'a', 'é', '值', '😀', '\u0000', '"', '\\', ' { "x": 1 }\n']
function randomValue(column: LogicalColumnContract, next: () => number): unknown {
  if (column.nullable && next() < 0.15) return null
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!
  switch (column.logicalCodec) {
    case 'boolean':
      return pick([true, false, 0, 1, 0n, 1n])
    case 'integer':
    case 'epoch-milliseconds':
      return pick([
        0,
        -1,
        Number.MAX_SAFE_INTEGER,
        9007199254740993n,
        -9007199254740993n,
        '123',
        Math.floor(next() * 1e12),
      ])
    case 'real':
      return pick([0, -0, 1.5, -2.25, 1e300, 5e-324, next() * 1e6 - 5e5])
    case 'json-text':
      return pick(['{}', '[]', 'null', '1', '"s"', ' { "a": [1, 2] }\n', '{"值":"😀"}'])
    case 'opaque-bytes':
      return Uint8Array.from({ length: Math.floor(next() * 5) }, () => Math.floor(next() * 256))
    case 'text':
    case 'text-identity':
      return pick(TEXT) + pick(TEXT)
  }
}
/** A table that has one column of every codec. */
const codecs: LogicalTableContract = {
  ...runtimes,
  id: 'rfc626_codecs',
  migrationKey: ['k'],
  primaryKey: ['k'],
  columns: (
    [
      ['k', 'text', false],
      ['b', 'boolean', true],
      ['i', 'integer', true],
      ['e', 'epoch-milliseconds', true],
      ['r', 'real', true],
      ['j', 'json-text', true],
      ['t', 'text', true],
      ['ti', 'text-identity', true],
      ['o', 'opaque-bytes', true],
    ] as const
  ).map(([name, logicalCodec, nullable]) => ({ ...column('name'), name, logicalCodec, nullable })),
}

function cell(entry: LogicalColumnContract, index: number): CanonicalLogicalValue {
  switch (entry.logicalCodec) {
    case 'boolean':
      return { type: 'boolean', value: index % 2 === 0 }
    case 'integer':
    case 'epoch-milliseconds':
      return { type: 'integer', value: String(1_700_000_000_000 + index) }
    case 'real':
      return { type: 'real', value: '0.5' }
    case 'json-text':
      return { type: 'text', value: `["${index}"]` }
    case 'opaque-bytes':
      return { type: 'bytes', value: 'AQI=' }
    case 'text':
    case 'text-identity':
      return { type: 'text', value: `${entry.name}-${String(index).padStart(4, '0')}` }
  }
}
function runtimeRows(
  count: number,
  override: (
    index: number,
  ) => Readonly<Partial<Record<string, CanonicalLogicalValue>>> = () => ({}),
): CanonicalLogicalRow[] {
  return Array.from({ length: count }, (_, index) => {
    const replaced = override(index)
    const values = runtimes.columns.map((entry) => replaced[entry.name] ?? cell(entry, index))
    const key = runtimes.migrationKey.map(
      (name) => values[runtimes.columns.findIndex((entry) => entry.name === name)]!,
    )
    return { key, values }
  })
}
const NON_FINITE = ['NaN', 'Infinity', '-Infinity'] as const
/** One row with each refused value, placed so that they fall into different chunks. */
const refused = runtimeRows(7, (index) =>
  index === 0
    ? { temperature: { type: 'real', value: 'NaN' } }
    : index === 3
      ? { extra_args_json: { type: 'text', value: 'not json' } }
      : index === 4
        ? { temperature: { type: 'real', value: 'Infinity' } }
        : index === 6
          ? { temperature: { type: 'real', value: '-Infinity' } }
          : {},
)

async function exportRuntimes(
  root: string,
  rows: readonly CanonicalLogicalRow[],
  valueRule?: LogicalValueRule,
) {
  const after = (key: readonly CanonicalLogicalValue[] | null) =>
    key === null ? 0 : rows.findIndex((row) => JSON.stringify(row.key) === JSON.stringify(key)) + 1
  return exportLogicalDatabaseArtifact({
    operationId: OPERATION,
    sourceProvider: 'sqlite',
    sourceGenerationId: GENERATION,
    contract,
    artifactRoot: root,
    chunkRows: 2,
    now: () => 123,
    expectedTableRows: Object.fromEntries(
      contract.tables
        .filter((table) => table.providerTables.sqlite !== undefined)
        .map((table) => [table.id, table.id === 'runtimes' ? rows.length : 0]),
    ),
    source: {
      provider: 'sqlite',
      async assertUnchanged() {},
      async readChunk(table, afterKey, limit) {
        if (table.id !== 'runtimes') return []
        const start = after(afterKey)
        return rows.slice(start, start + limit)
      },
    },
    ...(valueRule ? { valueRule } : {}),
  })
}
function filesOf(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const visit = (path: string) => {
    if (statSync(path).isDirectory()) for (const name of readdirSync(path)) visit(join(path, name))
    else files.set(relative(root, path), readFileSync(path).toString('base64'))
  }
  visit(root)
  return files
}
function temporary(): { readonly root: string; done(): void } {
  const root = mkdtempSync(join(tmpdir(), 'rfc626-transport-'))
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}

describe('RFC-626 §3.3 transport value rule of the logical codec', () => {
  test('JSON text that is not JSON: strict refuses, transport keeps it as the same text', () => {
    const json = column('extra_args_json')
    expect(json.logicalCodec).toBe('json-text')
    for (const value of ['not json', '{', '', '[1,]']) {
      expect(() => encodeLogicalValue('runtimes', json, value)).toThrow(LogicalDatabaseCodecError)
      try {
        encodeLogicalValue('runtimes', json, value)
      } catch (error) {
        expect((error as LogicalDatabaseCodecError).code).toBe('logical-codec-json')
      }
      expect(encodeLogicalValue('runtimes', json, value, 'transport')).toEqual({
        type: 'text',
        value,
      })
    }
    // A non-string is refused by both: only the JSON rule is relaxed.
    expect(() => encodeLogicalValue('runtimes', json, 1, 'transport')).toThrow(
      LogicalDatabaseCodecError,
    )
  })

  test('NaN and ±Infinity: strict refuses, transport writes their text form', () => {
    const real = column('temperature')
    expect(real.logicalCodec).toBe('real')
    for (const [value, text] of [
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
      [Number.NEGATIVE_INFINITY, '-Infinity'],
    ] as const) {
      expect(() => encodeLogicalValue('runtimes', real, value)).toThrow(LogicalDatabaseCodecError)
      expect(encodeLogicalValue('runtimes', real, value, 'transport')).toEqual({
        type: 'real',
        value: text,
      })
    }
    // Not a number is still refused, and -0 keeps its canonical form under both rules.
    expect(() => encodeLogicalValue('runtimes', real, '1.5', 'transport')).toThrow(
      LogicalDatabaseCodecError,
    )
    expect(encodeLogicalValue('runtimes', real, -0, 'transport')).toEqual({
      type: 'real',
      value: '0',
    })
    // NULL and nullability are untouched.
    expect(encodeLogicalValue('runtimes', real, null, 'transport')).toEqual({ type: 'null' })
    expect(() =>
      encodeLogicalValue('runtimes', { ...real, nullable: false }, null, 'transport'),
    ).toThrow(LogicalDatabaseCodecError)
  })

  test('property: every row the strict rule accepts encodes to the same bytes under both rules', () => {
    for (const seed of [1, 2, 3, 626, 9_001]) {
      const next = random(seed)
      const rows: CanonicalLogicalRow[] = []
      for (let index = 0; index < 400; index += 1) {
        const decoded = Object.fromEntries(
          codecs.columns.map((entry) => [
            entry.name,
            entry.name === 'k' ? `k-${String(index).padStart(4, '0')}` : randomValue(entry, next),
          ]),
        )
        const strict = encodeLogicalRow(codecs, decoded)
        const transport = encodeLogicalRow(codecs, decoded, 'transport')
        expect(canonicalSchemaJson(transport)).toBe(canonicalSchemaJson(strict))
        rows.push(strict)
      }
      const strictChunk = createLogicalTableChunk({
        operationId: OPERATION,
        contract,
        table: codecs,
        chunkIndex: 0,
        rows,
      })
      const transportChunk = createLogicalTableChunk({
        operationId: OPERATION,
        contract,
        table: codecs,
        chunkIndex: 0,
        rows,
        valueRule: 'transport',
      })
      expect(transportChunk.digest).toBe(strictChunk.digest)
      expect(canonicalSchemaJson(transportChunk)).toBe(canonicalSchemaJson(strictChunk))
    }
  })

  test('chunks: strict refuses a non-finite real, transport builds and verifies it', () => {
    const rows = runtimeRows(2, (index) =>
      index === 0 ? { temperature: { type: 'real', value: NON_FINITE[0] } } : {},
    )
    const build = (valueRule?: LogicalValueRule) =>
      createLogicalTableChunk({
        operationId: OPERATION,
        contract,
        table: runtimes,
        chunkIndex: 0,
        rows,
        ...(valueRule ? { valueRule } : {}),
      })
    expect(() => build()).toThrow()
    const chunk = build('transport')
    const json = JSON.parse(canonicalSchemaJson(chunk)) as unknown
    expect(() => verifyLogicalTableChunk(json)).toThrow(LogicalDatabaseCodecError)
    expect(verifyLogicalTableChunk(json, 'transport').digest).toBe(chunk.digest)
    // Only the three non-finite spellings are admitted; anything else is still corrupt.
    const other = JSON.parse(canonicalSchemaJson(chunk)) as {
      payload: { rows: { values: CanonicalLogicalValue[] }[] }
      digest: string
    }
    other.payload.rows[0]!.values[runtimes.columns.indexOf(column('temperature'))] = {
      type: 'real',
      value: 'nan',
    }
    // Re-digested, so the value rule is the only thing that can refuse it.
    other.digest = digestSchemaContract(other.payload)
    expect(() => verifyLogicalTableChunk(other, 'transport')).toThrow(LogicalDatabaseCodecError)
  })
})

describe('RFC-626 §3.3 backup export and read-back under the transport rule', () => {
  test('rows both rules accept: the transport export is byte-identical to the strict one', async () => {
    const strict = temporary()
    const transport = temporary()
    try {
      const rows = runtimeRows(5)
      const a = await exportRuntimes(strict.root, rows)
      const b = await exportRuntimes(transport.root, rows, 'transport')
      expect(b.envelopeFileDigest).toBe(a.envelopeFileDigest)
      expect(b.manifest).toEqual(a.manifest)
      expect(filesOf(transport.root)).toEqual(filesOf(strict.root))
    } finally {
      strict.done()
      transport.done()
    }
  })

  test('refused values: transport exports and reads back, strict refuses on both sides', async () => {
    const strictExport = temporary()
    const transport = temporary()
    try {
      await expect(exportRuntimes(strictExport.root, refused)).rejects.toThrow()
      const receipt = await exportRuntimes(transport.root, refused, 'transport')
      expect(receipt.activeRows).toBe(refused.length)
      const verify = (valueRule?: LogicalValueRule) =>
        openVerifiedLogicalDatabaseArtifactSource({
          artifactRoot: transport.root,
          expectedManifestDigest: receipt.manifest.digest,
          expectedLegacyArchiveFileDigest: receipt.legacyArchiveFileDigest,
          contract,
          ...(valueRule ? { valueRule } : {}),
        })
      expect(() => verify()).toThrow(LogicalDatabaseRestoreError)
      const source = verify('transport')
      const entry = source.verification.manifest.payload.tables.find(
        (table) => table.table === 'runtimes',
      )!
      expect(entry.chunkCount).toBe(4)
      const values = Array.from({ length: entry.chunkCount }, (_, index) =>
        source.readChunk(runtimes, index),
      ).flatMap((chunk) => chunk.payload.rows)
      expect(values).toEqual(refused)
    } finally {
      strictExport.done()
      transport.done()
    }
  })

  test('JSON text that is not JSON passes the strict export but not the strict read-back', async () => {
    const target = temporary()
    try {
      const rows = runtimeRows(3, (index) =>
        index === 1 ? { extra_args_json: { type: 'text', value: '{"open":' } } : {},
      )
      const receipt = await exportRuntimes(target.root, rows)
      const input = {
        artifactRoot: target.root,
        expectedManifestDigest: receipt.manifest.digest,
        expectedLegacyArchiveFileDigest: receipt.legacyArchiveFileDigest,
        contract,
      }
      expect(() => openVerifiedLogicalDatabaseArtifactSource(input)).toThrow(
        LogicalDatabaseRestoreError,
      )
      expect(() =>
        openVerifiedLogicalDatabaseArtifactSource({ ...input, valueRule: 'transport' }),
      ).not.toThrow()
    } finally {
      target.done()
    }
  })
})

function manifestFor(envelopeFileDigest: string, valueRule?: 'transport'): BackupManifestV2 {
  return {
    manifestVersion: 2,
    kind: 'pre-migration',
    createdAt: 123,
    appVersion: 'rfc626-transport',
    includesWorktrees: false,
    migration: { lastHash: null, lastCreatedAt: null },
    database: {
      format: 'agent-workflow-logical-database-v1',
      provider: 'sqlite',
      sourceGenerationId: GENERATION,
      schemaDigest: contract.digest,
      logicalPath: 'database/logical',
      envelopeFileDigest,
      rawSqlitePath: null,
      ...(valueRule ? { valueRule } : {}),
    },
  }
}

describe('RFC-626 §3.3 the backup manifest records the value rule', () => {
  test('the field round-trips, is optional, and only `transport` is accepted', () => {
    const target = temporary()
    try {
      const digest = `sha256:${'a'.repeat(64)}`
      writeManifest(target.root, manifestFor(digest, 'transport'))
      const recorded = readManifest(target.root)
      expect(recorded?.manifestVersion === 2 ? recorded.database.valueRule : null).toBe('transport')
      expect(backupValueRule(recorded)).toBe('transport')
      writeManifest(target.root, manifestFor(digest))
      const plain = readManifest(target.root)
      expect(plain?.manifestVersion === 2 ? plain.database.valueRule : 'x').toBeUndefined()
      expect(backupValueRule(plain)).toBe('strict')
      expect(backupValueRule(null)).toBe('strict')
      const odd = {
        ...manifestFor(digest),
        database: { ...manifestFor(digest).database, valueRule: 'loose' },
      }
      writeFileSync(join(target.root, 'manifest.json'), JSON.stringify(odd))
      expect(readManifest(target.root)).toBeNull()
    } finally {
      target.done()
    }
  })

  test('a backup is read under the rule its manifest records', async () => {
    const backup = temporary()
    try {
      const artifactRoot = join(backup.root, 'database/logical')
      const receipt = await exportRuntimes(artifactRoot, refused, 'transport')
      writeManifest(backup.root, manifestFor(receipt.envelopeFileDigest, 'transport'))
      const open = () =>
        openEpoch1LogicalArtifactSource({
          artifactRoot,
          backupRoot: backup.root,
          envelopeFileDigest: receipt.envelopeFileDigest,
        })
      const reader = open()
      try {
        const preflight = await reader.preflight()
        expect(preflight.kind).toBe('logical-backup')
        // The conversion's strict read refuses these rows; its raw channel carries them.
        await expect(reader.readChunk('runtimes', null, 10)).rejects.toBeInstanceOf(
          SourceBlockedError,
        )
        const raw = await reader.readRawChunk('runtimes', null, 10)
        expect(raw.rows).toHaveLength(refused.length)
        const temperatures = raw.rows.map((row) => row.cells.temperature)
        expect(temperatures[0]).toEqual({
          storageClass: 'logical:real',
          value: { type: 'real', value: 'NaN' },
        })
        expect(raw.rows[3]?.cells.extra_args_json?.value).toEqual({
          type: 'text',
          value: 'not json',
        })
        await reader.assertUnchanged(preflight)
      } finally {
        await reader.close()
      }
      // The same files without the recorded rule are read strictly, and refused.
      writeManifest(backup.root, manifestFor(receipt.envelopeFileDigest))
      const strict = open()
      try {
        await expect(strict.preflight()).rejects.toBeInstanceOf(SourceBlockedError)
      } finally {
        await strict.close()
      }
    } finally {
      backup.done()
    }
  })

  test('for rows both rules accept, both rules read the backup identically', async () => {
    const backup = temporary()
    try {
      const artifactRoot = join(backup.root, 'database/logical')
      const receipt = await exportRuntimes(artifactRoot, runtimeRows(5), 'transport')
      const read = async (valueRule?: 'transport') => {
        writeManifest(backup.root, manifestFor(receipt.envelopeFileDigest, valueRule))
        const reader = openEpoch1LogicalArtifactSource({
          artifactRoot,
          backupRoot: backup.root,
          envelopeFileDigest: receipt.envelopeFileDigest,
        })
        try {
          await reader.preflight()
          return {
            chunk: await reader.readChunk('runtimes', null, 3),
            raw: await reader.readRawChunk('runtimes', null, 3),
            rest: await reader.readRawChunk(
              'runtimes',
              (await reader.readChunk('runtimes', null, 3)).lastKey,
              10,
            ),
          }
        } finally {
          await reader.close()
        }
      }
      const transport = await read('transport')
      const strict = await read()
      expect(transport.chunk).toEqual(strict.chunk)
      expect(transport.raw).toEqual(strict.raw)
      expect(transport.rest).toEqual(strict.rest)
      expect(transport.rest.rows).toHaveLength(2)
    } finally {
      backup.done()
    }
  })
})
