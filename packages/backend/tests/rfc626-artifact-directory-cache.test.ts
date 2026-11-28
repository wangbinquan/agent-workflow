// RFC-626 §4.6: the retained RFC-349 archive a PostgreSQL source is composed with (and any
// logical artifact read as a source) is hashed and verified once per process for as long as
// its directory stays the same.
//
// Why these tests exist: one upgrade used to hash the whole archive directory about 36 times
// and verify all of its chunks about 7 times — once for every check of the source. The cache
// must never become an unconditional process-wide one: its key is the directory path plus a
// signature of every entry (size, inode, change and modification times) and the digest of the
// manifest files, so any change to the directory is measured and verified again — and a
// tampered archive is still refused.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  artifactDirectorySignature,
  cachedSourceFilesDigest,
  cachedVerifiedArtifactSource,
} from '@/platform/persistence/migration/artifactDirectoryCache'
import { openEpoch1LogicalArtifactSource } from '@/platform/persistence/migration/artifactSourceReader'
import { composePostgresqlArchiveSource } from '@/platform/persistence/migration/conversion/postgresqlArchiveSource'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { resolvePostgresqlSourceArchive } from '@/platform/persistence/migration/freeze/postgresqlArchive'
import {
  logicalArtifactFileDigest,
  type CanonicalLogicalRow,
  type CanonicalLogicalValue,
} from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import { exportLogicalDatabaseArtifact } from '@/platform/persistence/migration/legacy/logicalDatabaseExport'
import { LogicalDatabaseRestoreError } from '@/platform/persistence/migration/legacy/logicalDatabaseRestore'
import { sourceFilesDigest } from '@/platform/persistence/migration/sourceReader'
import {
  SourceBlockedError,
  type SourceFingerprint,
  type SourceMeasurement,
  type SourceMeasurementObserver,
  type SourcePreflight,
  type VersionedSourceReader,
} from '@/platform/persistence/migration/sourceTypes'

const contract = frozenEpoch1Contract
const maintenance = contract.tables.find((table) => table.id === 'maintenance_state')!
const OPERATION = 'dbm_rfc626_archive_cache'

/**
 * File timestamps can be as coarse as one kernel tick; a rewrite right after the export could
 * otherwise carry the times the file was written with.
 */
const laterTick = () => Bun.sleep(50)

/** RFC-626 §7: counts the measurements of the calls it is handed to, by kind. */
function measurements(): {
  readonly onMeasure: SourceMeasurementObserver
  count(kind: SourceMeasurement): number
} {
  const counts = new Map<SourceMeasurement, number>()
  return {
    onMeasure: (kind) => counts.set(kind, (counts.get(kind) ?? 0) + 1),
    count: (kind) => counts.get(kind) ?? 0,
  }
}

async function archiveDirectory(): Promise<{
  readonly root: string
  readonly manifestDigest: string
  readonly legacyArchiveFileDigest: string
  readonly chunk: string
  done(): void
}> {
  const root = mkdtempSync(join(tmpdir(), 'rfc626-archive-cache-'))
  const value = (name: string, key: string): CanonicalLogicalValue => {
    const column = maintenance.columns.find((entry) => entry.name === name)!
    if (name === 'key') return { type: 'text', value: `rfc626-${key}` }
    return column.logicalCodec === 'epoch-milliseconds' || column.logicalCodec === 'integer'
      ? { type: 'integer', value: '123' }
      : { type: 'text', value: `{"value":"${key}"}` }
  }
  const rows: CanonicalLogicalRow[] = ['a', 'b', 'c'].map(
    (key): CanonicalLogicalRow => ({
      key: [value('key', key)],
      values: maintenance.columns.map((column) => value(column.name, key)),
    }),
  )
  const receipt = await exportLogicalDatabaseArtifact({
    operationId: OPERATION,
    sourceProvider: 'sqlite',
    sourceGenerationId: 'dbg_rfc626_archive_cache',
    contract,
    artifactRoot: root,
    chunkRows: 2,
    now: () => 123,
    expectedTableRows: Object.fromEntries(
      contract.tables.map((table) => [table.id, table.id === maintenance.id ? rows.length : 0]),
    ),
    source: {
      provider: 'sqlite',
      async assertUnchanged() {},
      async readChunk(table, afterKey) {
        if (table.id !== maintenance.id) return []
        return afterKey === null ? rows.slice(0, 2) : rows.slice(2)
      },
    },
  })
  return {
    root,
    manifestDigest: receipt.manifest.digest,
    legacyArchiveFileDigest: receipt.legacyArchiveFileDigest,
    chunk: join(root, 'chunks', maintenance.id, 'chunk-00000000.json'),
    done: () => rmSync(root, { recursive: true, force: true }),
  }
}
/** Same size, different bytes: only the content and the file times change. */
function rewrite(path: string): void {
  const text = readFileSync(path, 'utf8')
  const changed = text.replace('rfc626-a', 'rfc626-z')
  expect(changed).not.toBe(text)
  expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(text))
  writeFileSync(path, changed)
}

describe('RFC-626 §4.6 directory digest cache', () => {
  test('one digest while the directory is unchanged, a new one after any change', async () => {
    const archive = await archiveDirectory()
    try {
      const measured = measurements()
      const digest = () => cachedSourceFilesDigest(archive.root, measured.onMeasure)
      const first = await digest()
      expect(first).toBe(await sourceFilesDigest(archive.root))
      for (let index = 0; index < 5; index += 1) expect(await digest()).toBe(first)
      expect(measured.count('directory-digest')).toBe(1)

      await laterTick()
      rewrite(archive.chunk)
      const rewritten = await digest()
      expect(rewritten).not.toBe(first)
      expect(rewritten).toBe(await sourceFilesDigest(archive.root))
      expect(measured.count('directory-digest')).toBe(2)

      await laterTick()
      writeFileSync(join(archive.root, 'extra.json'), '{}')
      const added = await digest()
      expect(added).not.toBe(rewritten)
      expect(added).toBe(await sourceFilesDigest(archive.root))
      expect(measured.count('directory-digest')).toBe(3)
    } finally {
      archive.done()
    }
  })

  test('the signature covers the path, every entry and the manifest bytes', async () => {
    const one = await archiveDirectory()
    const two = await archiveDirectory()
    try {
      const signature = artifactDirectorySignature(one.root)
      expect(artifactDirectorySignature(one.root)).toBe(signature)
      // Another directory with identical files is still another key.
      expect(artifactDirectorySignature(two.root)).not.toBe(signature)
      await laterTick()
      const manifest = join(one.root, 'logical-manifest.json')
      writeFileSync(manifest, readFileSync(manifest))
      expect(artifactDirectorySignature(one.root)).not.toBe(signature)
    } finally {
      one.done()
      two.done()
    }
  })
})

describe('RFC-626 §4.6 verified artifact cache', () => {
  test('the tree is verified once per rule and verified again after a change', async () => {
    const archive = await archiveDirectory()
    try {
      const input = {
        artifactRoot: archive.root,
        expectedManifestDigest: archive.manifestDigest,
        expectedLegacyArchiveFileDigest: archive.legacyArchiveFileDigest,
        contract,
      }
      const measured = measurements()
      const verify = (value: Parameters<typeof cachedVerifiedArtifactSource>[0]) =>
        cachedVerifiedArtifactSource(value, measured.onMeasure)
      const first = verify(input)
      expect(verify(input)).toBe(first)
      expect(verify({ ...input })).toBe(first)
      expect(measured.count('tree-verification')).toBe(1)
      // The cached source still verifies every chunk it hands out.
      expect(first.readChunk(maintenance, 0).payload.rows).toHaveLength(2)
      // Another rule is another verification.
      verify({ ...input, valueRule: 'transport' })
      expect(measured.count('tree-verification')).toBe(2)

      await laterTick()
      rewrite(archive.chunk)
      expect(() => verify(input)).toThrow(LogicalDatabaseRestoreError)
      expect(measured.count('tree-verification')).toBe(3)
      // A refused tree is not remembered: asking again verifies (and refuses) again.
      expect(() => verify(input)).toThrow(LogicalDatabaseRestoreError)
      expect(measured.count('tree-verification')).toBe(4)
    } finally {
      archive.done()
    }
  })

  test('resolving the retained archive again reuses its verification', async () => {
    const archive = await archiveDirectory()
    try {
      const retained = {
        kind: 'retained-epoch1-archive' as const,
        path: archive.root,
        digest: logicalArtifactFileDigest(join(archive.root, 'legacy-archive/manifest.json')),
      }
      const details = {
        originalPreflight: {} as SourcePreflight,
        originalReader: {} as VersionedSourceReader,
      }
      const measured = measurements()
      const resolve = () => resolvePostgresqlSourceArchive(details, retained, measured.onMeasure)
      const first = await resolve()
      for (let index = 0; index < 4; index += 1)
        expect((await resolve()).preservedArchive).toBe(first.preservedArchive)
      expect(measured.count('tree-verification')).toBe(1)

      await laterTick()
      rewrite(archive.chunk)
      await expect(resolve()).rejects.toBeInstanceOf(LogicalDatabaseRestoreError)
      expect(measured.count('tree-verification')).toBe(2)
    } finally {
      archive.done()
    }
  })

  test('an archive reader answers repeated checks without hashing or verifying again', async () => {
    const archive = await archiveDirectory()
    const measured = measurements()
    const reader = openEpoch1LogicalArtifactSource({
      artifactRoot: archive.root,
      manifestDigest: archive.manifestDigest,
      legacyArchiveFileDigest: archive.legacyArchiveFileDigest,
      onMeasure: measured.onMeasure,
    })
    try {
      const preflight = await reader.preflight()
      for (let index = 0; index < 6; index += 1) await reader.assertUnchanged(preflight)
      expect(await reader.preflight()).toBe(preflight)
      expect(measured.count('directory-digest')).toBe(1)
      expect(measured.count('tree-verification')).toBe(1)
      expect(
        (await reader.readChunk(maintenance.id, null, 10)).decodedRows.map((row) => row.key),
      ).toEqual(['rfc626-a', 'rfc626-b', 'rfc626-c'])

      await laterTick()
      writeFileSync(join(archive.root, 'extra.json'), '{}')
      await expect(reader.assertUnchanged(preflight)).rejects.toBeInstanceOf(SourceBlockedError)
      expect(measured.count('directory-digest')).toBe(2)
    } finally {
      await reader.close()
      archive.done()
    }
  })
})

describe('RFC-626 §4.6 composed PostgreSQL archive source', () => {
  const archiveOnly = contract.tables
    .filter((table) => table.disposition === 'ARCHIVE_THEN_OMIT')
    .map((table) => table.id)
  const fingerprint: SourceFingerprint = {
    version: 1,
    evidence: 'physical-catalog-and-journal',
    provider: 'postgresql',
    catalog: [],
    catalogDigest: `sha256:${'c'.repeat(64)}`,
    journal: [],
    journalEntryCount: 0,
    tableRows: {},
    digest: `sha256:${'f'.repeat(64)}`,
  }
  const preflight = (overrides: Partial<SourcePreflight>): SourcePreflight => ({
    version: 1,
    kind: 'postgresql-database',
    sourceVersion: 'rfc626-fixture',
    contract,
    fingerprint,
    sourceGenerationId: 'dbg_rfc626_archive_cache',
    identityHighWater: [],
    identityEvidence: 'physical',
    watermark: `sha256:${'1'.repeat(64)}`,
    requiresOfflineUpgrade: false,
    tables: [],
    expectedAbsent: [],
    content: [],
    ...overrides,
  })
  function fake(value: SourcePreflight) {
    let checks = 0
    const reader = {
      kind: value.kind,
      preflight: async () => value,
      async assertUnchanged(expected: SourcePreflight) {
        expect(expected).toBe(value)
        checks += 1
      },
      readChunk: async () => {
        throw new Error('not read here')
      },
      readRawChunk: async () => {
        throw new Error('not read here')
      },
      close: async () => {},
    } as VersionedSourceReader
    return { reader, checks: () => checks }
  }

  test('an equal plan passes and checks both parts; a different plan is refused first', async () => {
    const physical = fake(preflight({ expectedAbsent: archiveOnly }))
    const archive = fake(
      preflight({
        kind: 'logical-artifact',
        watermark: `sha256:${'2'.repeat(64)}`,
        tables: archiveOnly.map((table) => ({
          table,
          rows: 0,
          physicalTable: table,
          destination: { kind: 'archive' },
          disposition: 'archived',
          reason: 'retained RFC-349 archive fixture',
        })),
      }),
    )
    const composed = await composePostgresqlArchiveSource({
      source: physical.reader,
      archive: archive.reader,
    })
    const plan = await composed.preflight()
    expect(physical.checks()).toBe(1)
    expect(archive.checks()).toBe(1)
    await composed.assertUnchanged(plan)
    await composed.assertUnchanged(structuredClone(plan))
    expect(physical.checks()).toBe(3)
    expect(archive.checks()).toBe(3)
    await expect(
      composed.assertUnchanged({ ...plan, watermark: `sha256:${'3'.repeat(64)}` }),
    ).rejects.toThrow('differs from the plan')
    expect(physical.checks()).toBe(3)
    expect(archive.checks()).toBe(3)
  })
})
