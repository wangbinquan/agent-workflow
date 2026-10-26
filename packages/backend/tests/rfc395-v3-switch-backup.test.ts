// RFC-395 V3-F: backups bind an identified snapshot and never omit committed WAL.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describeV1Providers } from './helpers/rfc395V1Harness'
import {
  openFrozenSource,
  openBackupSource,
  type SourceAccessInput,
} from '@/platform/persistence/migration/freeze/sourceAccess'
import {
  createSwitchBackup,
  switchBackupMatches,
  platformRetainedBackup,
  resolvePostgresqlBackupArchive,
} from '@/platform/persistence/migration/freeze/backup'
import { createLocalEpochArtifacts as createLocalSourceArtifacts } from '@/modules/system-operations/infrastructure/epochSwitch/fileJournal'
import { atomicSourceFile } from '@/platform/persistence/migration/freeze/artifacts'
import type {
  EpochSwitchArtifactPort,
  SourceArchiveInput,
} from '@/platform/persistence/migration/run/types'
import { frozenSourceDetails } from '@/platform/persistence/migration/freeze/sourceAccess'
import { logicalArtifactFileDigest } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import { createEpochBackupAdapter } from '@/modules/system-operations/infrastructure/epochSwitch/backupAdapter'
import { captureContentManifest } from '@/platform/content/inventory/manifest'
import { sourceFilesDigest } from '@/platform/persistence/migration/sourceReader'
import { readManifest } from '@/platform/persistence/migration/legacy/backupManifest'

describeV1Providers('RFC-395 V3 switch backup', (h) => {
  const input = async (): Promise<SourceAccessInput> => ({
    manifest: await h.manifest(),
    emptyTables: [],
    operationRoot: join(h.operationRoot, 'access'),
    location:
      h.provider === 'sqlite'
        ? {
            kind: 'sqlite-file',
            path: h.sqlitePath,
            pointerPath: join(h.operationRoot, 'pointer.json'),
          }
        : { kind: 'postgresql-database', profileRef: 'env:V3_SOURCE' },
    postgresql: () => h.runtime,
  })
  test('engine backup reopens through V1 with equal rows, reuse is verified and stale backups are retained', async () => {
    await h.install()
    await h.seed()
    if (h.provider === 'sqlite')
      h.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
    await h.native.execute(
      `UPDATE ${h.table('maintenance_state')} SET value='committed-in-wal' WHERE key='v1-a'`,
    )
    const request = await input()
    const source = await openFrozenSource(request)
    const destination = join(h.operationRoot, 'backups')
    const create = (frozen: typeof source) =>
      h.provider === 'sqlite'
        ? createSwitchBackup({
            sourcePath: h.sqlitePath,
            destination,
            frozen,
            contentManifest: null,
          })
        : createSwitchBackup({
            source: frozen,
            destination,
            operationId: 'dbm_v3_backup',
            chunkRows: 2,
            archive: { emptyArchive: { kind: 'born-hosted', async assertProvenance() {} } },
          })
    const receipt = await create(source)
    expect(receipt.kind).toBe(h.provider === 'sqlite' ? 'sqlite-vacuum' : 'postgresql-logical')
    expect(await switchBackupMatches(receipt, source.watermark)).toBe(true)
    expect(await create(source)).toEqual(receipt)
    const manifest = readManifest(receipt.path!)!
    expect(manifest.kind).toBe('pre-migration')
    expect(manifest.manifestVersion).toBe(h.provider === 'sqlite' ? 1 : 2)
    const reader = openBackupSource({
      location: {
        kind: 'backup',
        sourceKind: h.provider === 'sqlite' ? 'sqlite-backup' : 'logical-backup',
        artifact: receipt.path!,
        root: receipt.path!,
      },
      manifest: request.manifest,
      operationRoot: join(h.operationRoot, 'verify'),
      emptyTables: [],
    })
    try {
      await reader.preflight()
      expect((await reader.readChunk('maintenance_state', null, 100)).rows).toEqual(
        (await source.reader.readChunk('maintenance_state', null, 100)).rows,
      )
    } finally {
      await reader.close()
      await source.close()
    }
    await h.native.execute(
      `UPDATE ${h.table('maintenance_state')} SET value='new-freeze' WHERE key='v1-a'`,
    )
    const newer = await openFrozenSource(request)
    try {
      expect(await switchBackupMatches(receipt, newer.watermark)).toBe(false)
      const fresh = await create(newer)
      expect(fresh.path).not.toBe(receipt.path)
      expect(existsSync(receipt.path!)).toBe(true)
      expect(await switchBackupMatches(fresh, newer.watermark)).toBe(true)
      writeFileSync(join(fresh.path!, 'unexpected.txt'), 'changed')
      expect(await switchBackupMatches(fresh, newer.watermark)).toBe(false)
    } finally {
      await newer.close()
    }
  }, 300_000)

  test('restoring a backup records immutable-backup-source and hosted retention requires a verifier', async () => {
    const version = await h.install()
    const portable = await h.backup(version)
    const request = await input()
    const source = await openFrozenSource({
      ...request,
      location: {
        kind: 'backup',
        sourceKind: 'hosted-backup',
        artifact: portable.root,
        root: portable.root,
      },
    })
    try {
      const adapter = createEpochBackupAdapter()
      const receipt = await adapter.create({
        operationId: 'dbm_v3_restore',
        source,
        destination: join(h.operationRoot, 'immutable'),
      })
      expect(receipt.kind).toBe('immutable-backup-source')
      expect(receipt.digest).toBe(await sourceFilesDigest(portable.root))
      expect(await adapter.matches(receipt, source.watermark)).toBe(true)
      const retained = platformRetainedBackup({
        id: 'retained-fixture',
        frozenWatermark: source.watermark,
        retentionDigest: receipt.digest,
        contentManifestDigest: null,
        createdAt: 123,
      })
      expect(await adapter.matches(retained, source.watermark)).toBe(false)
      expect(
        await createEpochBackupAdapter({
          async retainedMatches(r, watermark) {
            return r.digest === retained.digest && watermark === retained.sourceWatermark
          },
        }).matches(retained, source.watermark),
      ).toBe(true)
    } finally {
      await source.close()
      portable.close()
    }
  }, 300_000)

  test('backup payload re-materialises on a fresh Job and an incomplete backup copy is cleaned', async () => {
    await h.install()
    await h.seed()
    const source = await openFrozenSource(await input())
    const job1 = join(h.operationRoot, 'job1')
    const job2 = join(h.operationRoot, 'job2')
    const store = createLocalSourceArtifacts(join(h.operationRoot, 'durable'))
    const references = new Map<string, string>()
    const port = (root: string): EpochSwitchArtifactPort => ({
      async put(name, bytes) {
        const digest = await store.put(name, bytes)
        references.set(name, digest)
        return digest
      },
      async get(name, digest) {
        const path = await store.get(name, digest)
        const local = join(root, name)
        await atomicSourceFile(local, readFileSync(path))
        return local
      },
    })
    const destination = join(job1, 'backup')
    mkdirSync(join(destination, 'switch-crashed/payload'), { recursive: true })
    writeFileSync(join(destination, 'switch-crashed/payload/db.sqlite'), 'incomplete')
    const preflight = frozenSourceDetails(source).originalPreflight
    const archive: SourceArchiveInput = {
      kind: 'never-installed',
      evidence: {
        sourceBornOn: 'postgresql',
        sourceGenerationId: preflight.sourceGenerationId,
        sourceWatermark: preflight.watermark,
        catalogDigest: preflight.fingerprint.catalogDigest,
        expectedAbsent: preflight.expectedAbsent,
      },
    }
    try {
      const receipt = await createEpochBackupAdapter().create({
        operationId: 'dbm_artifacts',
        source,
        destination,
        artifacts: port(job1),
        ...(h.provider === 'postgresql' ? { postgresqlArchive: archive } : {}),
      })
      expect(existsSync(join(destination, 'switch-crashed'))).toBe(false)
      expect(
        [...references.keys()].some((name) =>
          name.startsWith(`switch-backups/${receipt.id}/payload/`),
        ),
      ).toBe(true)
      rmSync(job1, { recursive: true, force: true })
      const restored = port(job2)
      for (const [name, digest] of [...references]) await restored.get(name, digest)
      const freshAdapter = createEpochBackupAdapter({ artifacts: () => restored })
      expect(await freshAdapter.matches(receipt, source.watermark)).toBe(true)
      expect(await freshAdapter.matches(receipt, 'changed-watermark')).toBe(false)
      const payload = join(job2, `switch-backups/${receipt.id}/payload`)
      writeFileSync(join(payload, 'unexpected'), 'drift')
      expect(await freshAdapter.matches(receipt, source.watermark)).toBe(false)
    } finally {
      await source.close()
    }
  }, 300_000)

  if (h.provider === 'postgresql')
    test('typed PostgreSQL archive inputs verify retained bytes and all six never-installed catalog facts', async () => {
      const version = await h.install()
      await h.seed()
      // The backup helper establishes the installed generation and borrows its
      // own reader plus a catalog connection. Finish it before pinning the source.
      const backup = await h.backup(version)
      const source = await openFrozenSource(await input())
      const preflight = frozenSourceDetails(source).originalPreflight
      const absent = preflight
        .contract!.tables.filter((table) => table.disposition === 'ARCHIVE_THEN_OMIT')
        .map((table) => table.id)
      const evidence = {
        sourceBornOn: 'postgresql' as const,
        sourceGenerationId: preflight.sourceGenerationId,
        sourceWatermark: preflight.watermark,
        catalogDigest: preflight.fingerprint.catalogDigest,
        expectedAbsent: absent,
      }
      try {
        expect(absent).toHaveLength(6)
        const adapter = createEpochBackupAdapter()
        const receipt = await adapter.create({
          source,
          operationId: 'dbm_archive_fixture',
          destination: join(h.operationRoot, 'never-installed'),
          postgresqlArchive: { kind: 'never-installed', evidence },
        })
        expect(await adapter.matches(receipt, source.watermark)).toBe(true)
        for (const changed of [
          { ...evidence, expectedAbsent: absent.slice(1) },
          { ...evidence, catalogDigest: 'sha256:' + '0'.repeat(64) },
          { ...evidence, sourceGenerationId: 'other' },
          { ...evidence, sourceWatermark: 'other' },
        ])
          await expect(
            resolvePostgresqlBackupArchive(source, { kind: 'never-installed', evidence: changed }),
          ).rejects.toThrow('postgresql-never-installed-evidence-mismatch')
        const retained: SourceArchiveInput = {
          kind: 'retained-epoch1-archive',
          path: backup.artifactRoot,
          digest: logicalArtifactFileDigest(
            join(backup.artifactRoot, 'legacy-archive/manifest.json'),
          ),
        }
        expect(
          (await resolvePostgresqlBackupArchive(source, retained)).preservedArchive,
        ).toBeDefined()
        await expect(
          resolvePostgresqlBackupArchive(source, {
            ...retained,
            digest: 'sha256:' + '0'.repeat(64),
          }),
        ).rejects.toThrow('postgresql-archive-digest-mismatch')
        const retainedReceipt = await adapter.create({
          source,
          operationId: 'dbm_retained',
          destination: join(h.operationRoot, 'retained'),
          postgresqlArchive: retained,
        })
        expect(await adapter.matches(retainedReceipt, source.watermark)).toBe(true)
      } finally {
        await source.close()
        backup.close()
      }
    }, 300_000)

  if (h.provider === 'sqlite')
    test('backup includes skills/config plus the content listing and refuses content changed after capture', async () => {
      await h.install()
      const source = await openFrozenSource(await input())
      const root = {
        kind: 'app-home' as const,
        root: join(h.operationRoot, 'home'),
        runsSupplied: true,
        objects: 'none' as const,
      }
      mkdirSync(join(root.root, 'skills/id/files'), { recursive: true })
      writeFileSync(join(root.root, 'skills/id/files/SKILL.md'), '\ufeffbody')
      writeFileSync(join(root.root, 'config.json'), '{}')
      try {
        const manifest = await captureContentManifest({
          source,
          root,
          destination: join(h.operationRoot, 'content.json'),
        })
        const receipt = await createSwitchBackup({
          sourcePath: h.sqlitePath,
          frozen: source,
          destination: join(h.operationRoot, 'backup'),
          contentManifest: manifest,
        })
        mkdirSync(join(root.root, 'logs'), { recursive: true })
        writeFileSync(join(root.root, 'logs/daemon.log'), 'quiesce log')
        const afterLogs = await captureContentManifest({
          source,
          root,
          destination: join(h.operationRoot, 'after-logs.json'),
        })
        expect(afterLogs.digest).toBe(manifest.digest)
        expect(
          await createSwitchBackup({
            sourcePath: h.sqlitePath,
            frozen: source,
            destination: join(h.operationRoot, 'backup'),
            contentManifest: afterLogs,
          }),
        ).toEqual(receipt)
        expect(receipt.contentManifestDigest).toBe(manifest.digest)
        expect(existsSync(join(receipt.path!, 'skills/id/files/SKILL.md'))).toBe(true)
        expect(existsSync(join(receipt.path!, 'config.json'))).toBe(true)
        writeFileSync(join(root.root, 'skills/id/files/SKILL.md'), 'changed after capture')
        await expect(
          createSwitchBackup({
            sourcePath: h.sqlitePath,
            frozen: source,
            destination: join(h.operationRoot, 'changed-backup'),
            contentManifest: manifest,
          }),
        ).rejects.toThrow('switch-backup-content-changed')
      } finally {
        await source.close()
      }
    }, 300_000)
})
