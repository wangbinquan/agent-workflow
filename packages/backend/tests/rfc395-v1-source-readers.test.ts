// RFC-395 II-b V1: all four reader kinds use frozen codecs, deterministic chunks and change watermarks.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { appendFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { exportEpoch1PostgresqlSource } from '@/platform/persistence/migration/postgresqlSourceExport'
import { describeV1Providers } from './helpers/rfc395V1Harness'
import {
  openEpoch1SqliteSource,
  openEpoch1SqliteBackupSource,
} from '@/platform/persistence/migration/sqliteSourceReader'
import {
  openEpoch1LogicalArtifactSource,
  openEpoch1HostedBackupSource,
} from '@/platform/persistence/migration/artifactSourceReader'
import {
  SourceBlockedError,
  type VersionedSourceReader,
} from '@/platform/persistence/migration/sourceTypes'
import {
  logicalArtifactFileDigest,
  verifyLogicalArtifactManifest,
} from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'

// Frozen readers export and verify all backup bytes take about 12 s per CI-scaled case; allow 40 s.
setDefaultTimeout(40000)

describeV1Providers('RFC-395 V1 source readers', (h) => {
  test('original logical-copy artifact is readable without a later backup envelope', async () => {
    const version = await h.install()
    await h.seed()
    const backup = await h.backup(version)
    const manifest = verifyLogicalArtifactManifest(
      JSON.parse(readFileSync(join(backup.artifactRoot, 'logical-manifest.json'), 'utf8')),
    )
    unlinkSync(join(backup.artifactRoot, 'logical-backup.json'))
    const reader = openEpoch1LogicalArtifactSource({
      artifactRoot: backup.artifactRoot,
      manifestDigest: manifest.digest,
      legacyArchiveFileDigest: logicalArtifactFileDigest(
        join(backup.artifactRoot, 'legacy-archive/manifest.json'),
      ),
    })
    try {
      const preflight = await reader.preflight()
      expect(preflight.fingerprint.evidence).toBe('legacy-logical-artifact')
      expect((await reader.readChunk('maintenance_state', null, 10)).decodedRows).toHaveLength(3)
      await reader.assertUnchanged(preflight)
    } finally {
      await reader.close()
      backup.close()
    }
  })
  const kinds =
    h.provider === 'sqlite'
      ? (['file', 'backup', 'logical', 'hosted'] as const)
      : (['logical', 'hosted'] as const)
  for (const kind of kinds)
    test(`${kind}: preflight, stable key chunks/digests, original bytes and mutation failure`, async () => {
      const version = await h.install()
      await h.seed()
      const backup = kind === 'file' ? undefined : await h.backup(version)
      const manifest = await h.manifest()
      const open = (): VersionedSourceReader => {
        if (kind === 'file')
          return openEpoch1SqliteSource({
            path: h.sqlitePath,
            manifest,
            operationRoot: h.operationRoot,
          })
        if (kind === 'backup')
          return openEpoch1SqliteBackupSource({
            backupRoot: backup!.root,
            manifest,
            operationRoot: h.operationRoot,
          })
        if (kind === 'hosted')
          return openEpoch1HostedBackupSource({
            backupRoot: backup!.root,
            supportedSources: manifest,
          })
        return openEpoch1LogicalArtifactSource({
          artifactRoot: backup!.artifactRoot,
          envelopeFileDigest: backup!.envelopeFileDigest,
          supportedSources: manifest,
        })
      }
      const reader = open()
      const replay = open()
      try {
        await expect(reader.readChunk('maintenance_state', null, 2)).rejects.toBeInstanceOf(
          SourceBlockedError,
        )
        const first = await reader.preflight()
        expect(first.requiresOfflineUpgrade).toBe(false)
        expect(first.tables.every((table) => table.disposition !== 'blocked')).toBe(true)
        await reader.assertUnchanged(structuredClone(first))
        if (kind === 'logical' || kind === 'hosted') {
          for (const entry of first.tables.filter(
            (table) => table.disposition === 'metadata' || table.disposition === 'archived',
          )) {
            const raw = await reader.readRawChunk(entry.table, null, 1)
            expect(raw.sourceVersion).toBe(first.sourceVersion)
            expect(raw.rows.length).toBe(Math.min(entry.rows, 1))
          }
        }
        const chunk1 = await reader.readChunk('maintenance_state', null, 2)
        const chunk2 = await reader.readChunk('maintenance_state', chunk1.lastKey, 2)
        expect([...chunk1.decodedRows, ...chunk2.decodedRows].map((row) => row.key)).toEqual([
          'v1-a',
          'v1-z',
          'v1-é',
        ])
        expect(chunk1.decodedRows[0]?.value).toBe('{ "original": 1 }\n')
        expect(chunk1.migrationKey).toEqual(['key'])
        expect(chunk1.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
        expect((await reader.readChunk('maintenance_state', chunk2.lastKey, 2)).rows).toEqual([])
        await replay.preflight()
        expect((await replay.readChunk('maintenance_state', null, 2)).sourceDigest).toBe(
          chunk1.sourceDigest,
        )
        expect((await replay.readChunk('maintenance_state', chunk1.lastKey, 2)).sourceDigest).toBe(
          chunk2.sourceDigest,
        )
        if (kind === 'logical')
          expect(first.content.every((entry) => entry.state === 'not-inventoried')).toBe(true)
        if (kind === 'hosted')
          expect(first.content.every((entry) => entry.state === 'external-not-inventoried')).toBe(
            true,
          )
        if (kind === 'backup')
          expect(first.content.map((entry) => [entry.path, entry.state])).toEqual([
            ['runs/', 'originally-absent'],
            ['logs/', 'originally-absent'],
            ['evidence/', 'originally-absent'],
          ])
        if (kind === 'file')
          await h.native.execute(
            `UPDATE ${h.table('maintenance_state')} SET value='changed' WHERE key='v1-a'`,
          )
        else appendFileSync(join(backup!.artifactRoot, 'logical-backup.json'), '\n')
        await expect(reader.assertUnchanged(first)).rejects.toBeInstanceOf(SourceBlockedError)
      } finally {
        await reader.close()
        await replay.close()
        backup?.close()
      }
    })
  test('a backup from a published older epoch-1 version retains its version and requires offline upgrade', async () => {
    const version = await h.install('pre-seq')
    await h.seed()
    const backup = await h.backup(version)
    const reader = openEpoch1LogicalArtifactSource({
      artifactRoot: backup.artifactRoot,
      envelopeFileDigest: backup.envelopeFileDigest,
      supportedSources: await h.manifest(),
    })
    try {
      const preflight = await reader.preflight()
      expect(preflight.contract!.digest).toBe(version.contract.digest)
      expect(preflight.requiresOfflineUpgrade).toBe(true)
      expect((await reader.readChunk('maintenance_state', null, 10)).decodedRows).toHaveLength(3)
    } finally {
      await reader.close()
      backup.close()
    }
  })
  if (h.provider === 'postgresql')
    for (const mutate of [false, true])
      test(`physical export uses one snapshot and bounded full checks; concurrent mutation=${mutate}`, async () => {
        await h.install()
        await h.seed()
        const source = await h.source()
        let checks = 0
        let checkMilliseconds = 0
        let chunks = 0
        const assertUnchanged = source.assertUnchanged.bind(source)
        source.assertUnchanged = async (expected) => {
          checks++
          const started = performance.now()
          try {
            await assertUnchanged(expected)
          } finally {
            checkMilliseconds += performance.now() - started
          }
        }
        const read = source.readChunk.bind(source)
        let changed = false
        source.readChunk = async (...args) => {
          chunks++
          const chunk = await read(...args)
          if (mutate && !changed && args[0] === 'maintenance_state') {
            changed = true
            await h.native.execute(
              `UPDATE ${h.table('maintenance_state')} SET value='changed-during-export' WHERE key='v1-a'`,
            )
          }
          return chunk
        }
        const artifactRoot = join(h.operationRoot, `bounded-export-${mutate}`)
        const started = performance.now()
        try {
          const exported = exportEpoch1PostgresqlSource({
            source,
            artifactRoot,
            operationId: 'dbm_pgxc_bounded_export',
            chunkRows: 1,
            emptyArchive: { kind: 'born-hosted', async assertProvenance() {} },
          })
          if (mutate) {
            await expect(exported).rejects.toThrow('source changed after preflight')
            expect(changed).toBe(true)
            expect(existsSync(join(artifactRoot, 'source-evidence/binding.json'))).toBe(false)
          } else {
            const receipt = await exported
            expect(
              receipt.manifest.payload.tables.find((table) => table.table === 'maintenance_state')
                ?.rowCount,
            ).toBe(3)
            expect(receipt.evidence.preflight.kind).toBe('postgresql-database')
          }
          expect(chunks).toBeGreaterThan(200)
          // This is a database-work bound, not a machine-dependent time threshold.
          expect(checks).toBe(2)
          console.info(
            'physical-export-timing',
            JSON.stringify({
              mutate,
              chunks,
              checks,
              checkMilliseconds: Math.round(checkMilliseconds),
              milliseconds: Math.round(performance.now() - started),
            }),
          )
        } finally {
          await source.close()
        }
      })
  if (h.provider === 'sqlite') {
    test('VACUUM snapshot includes committed WAL rows while excluding the live uncommitted transaction', async () => {
      await h.install()
      h.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
      await h.seed()
      h.sqlite.exec("BEGIN; INSERT INTO maintenance_state VALUES ('v1-uncommitted','hidden',123)")
      const reader = openEpoch1SqliteSource({
        path: h.sqlitePath,
        manifest: await h.manifest(),
        operationRoot: h.operationRoot,
      })
      try {
        const source = await reader.preflight()
        const rows = (await reader.readChunk('maintenance_state', null, 10)).decodedRows
        expect(rows.map((row) => row.key)).toEqual(['v1-a', 'v1-z', 'v1-é'])
        h.sqlite.exec('COMMIT')
        await expect(reader.assertUnchanged(source)).rejects.toBeInstanceOf(SourceBlockedError)
        expect((await reader.readChunk('maintenance_state', null, 10)).decodedRows).toEqual(rows)
      } finally {
        if (h.sqlite.inTransaction) h.sqlite.exec('ROLLBACK')
        await reader.close()
      }
    })
    test('manifest-v2 backup with a different raw SQLite payload is rejected before row conversion', async () => {
      const version = await h.install()
      await h.seed()
      const backup = await h.backup(version)
      const { Database } = await import('bun:sqlite')
      const raw = new Database(join(backup.root, 'db.sqlite'))
      raw.exec("UPDATE maintenance_state SET value='different' WHERE key='v1-a'")
      raw.close()
      const reader = openEpoch1SqliteBackupSource({
        backupRoot: backup.root,
        manifest: await h.manifest(),
        operationRoot: h.operationRoot,
      })
      try {
        await expect(reader.preflight()).rejects.toBeInstanceOf(SourceBlockedError)
      } finally {
        await reader.close()
        backup.close()
      }
    })
  }
})
