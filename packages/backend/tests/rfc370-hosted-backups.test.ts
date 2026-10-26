import { registerContentObjectInTx } from '@/platform/content/infrastructure/contentStore'
// RFC-370 v3 V5 — hosted database backups and their catalog. Locks: a backup
// is one archive published through the neutral journal in the transaction that
// makes the catalog row ready; workspaces are refused (C10); prune and failure
// only release catalog references (maintenance unpins behind the horizon); the
// lightweight verify is catalog + `stat`, never a download.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { createHostedBackupCatalog } from '@/modules/system-operations/infrastructure/crewstation/databaseBackupCatalog'
import {
  HOSTED_BACKUP_OWNER,
  parseHostedBackupReference,
  type HostedBackupSidecar,
} from '@/modules/system-operations/infrastructure/crewstation/databaseBackupFormat'
import {
  createHostedDatabaseBackups,
  HOSTED_BACKUP_HISTORY_MS,
  HostedBackupWorktreesUnsupportedError,
} from '@/modules/system-operations/infrastructure/crewstation/databaseBackups'
import {
  createHostedObjectPublications,
  hostedPublicationId,
} from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import type { PostgresqlLogicalSource } from '@/platform/persistence/postgresqlLogicalSource'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { describeEachProvider } from './helpers/eachProvider'
import { objectFixture } from './helpers/rfc370Objects'

const SPACE = '01a13e6d-3e00-7000-9e3c-00000000aaaa'

describeEachProvider('RFC-370 hosted database backups', (harness) => {
  function fixture(options: { failArchive?: boolean; protectedIds?: string[] } = {}) {
    const objects = objectFixture()
    let failArchive = options.failArchive ?? false
    let epoch = 1,
      timestamp = 10_000_000
    const fence = {
      current: () => ({ epoch, leaseId: `lease-${epoch}`, instanceId: `slot-${epoch}` }),
      async assertHeld(_tx: unknown, expected: { epoch: number }) {
        if (expected.epoch !== epoch) throw new Error('fence-lost')
      },
    }
    const journal = createHostedObjectPublications({
      db: harness.db,
      fence,
      objects: objects.objects,
      now: () => timestamp,
    })
    const directories: string[] = []
    const contract = logicalSchemaContract
    const backups = createHostedDatabaseBackups({
      db: harness.db,
      fence,
      publications: journal.publications,
      installation: 'project/service',
      objectSpaceId: SPACE,
      keyFingerprint: 'f'.repeat(64),
      contract,
      openSource: async () => ({}) as PostgresqlLogicalSource,
      workflows: { exportWorkflows: async () => 0 },
      assertBornHosted: async () => undefined,
      protectedBackupIds: async () => options.protectedIds ?? [],
      now: () => timestamp,
      async buildArchive(request) {
        if (failArchive) throw new Error('archive-export-failed')
        const directory = mkdtempSync(join(tmpdir(), 'rfc370-backup-test-'))
        directories.push(directory)
        const path = join(directory, 'backup.tar.gz')
        writeFileSync(path, `archive of ${request.backupId}`)
        const sidecar: HostedBackupSidecar = {
          format: 'aw-hosted-database-backup-v2',
          backupId: request.backupId,
          kind: request.kind,
          installation: request.installation,
          objectSpaceId: request.objectSpaceId,
          keyFingerprint: request.keyFingerprint,
          createdAt: request.createdAt,
          snapshotAt: request.createdAt + 5,
          schemaDigest: contract.digest,
          sourceGenerationId: 'dbg_hosted_backup_test',
          contents: { workflows: 3, skills: 2 },
        }
        return { path, sidecar, dispose: () => rmSync(directory, { recursive: true, force: true }) }
      },
    })
    const catalog = createHostedBackupCatalog({
      db: harness.db,
      objects: objects.objects,
      protectedBackupIds: async () => options.protectedIds ?? [],
      now: () => timestamp,
    })
    return {
      ...objects,
      journal,
      backups,
      catalog,
      advance: (ms: number) => {
        timestamp += ms
      },
      rotate: () => {
        epoch++
      },
      failArchives: () => {
        failArchive = true
      },
      rows: () => {
        const { hostedDatabaseBackups } = tablesOf(harness.db)
        return harness.db.select().from(hostedDatabaseBackups)
      },
      publication: async (id: string) => {
        const { contentPublications } = tablesOf(harness.db)
        return (
          await harness.db
            .select()
            .from(contentPublications)
            .where(eq(contentPublications.id, hostedPublicationId(HOSTED_BACKUP_OWNER, id)))
        )[0]
      },
    }
  }

  test('workspaces are refused with an explicit hosted reason before any row exists (C10)', async () => {
    const f = fixture()
    const error = await f.backups.backup.request({ includeWorktrees: true }).then(
      () => null,
      (value: unknown) => value,
    )
    expect(error).toBeInstanceOf(HostedBackupWorktreesUnsupportedError)
    expect(error).toMatchObject({ code: 'hosted-backup-worktrees-unsupported', status: 422 })
    expect(await f.rows()).toEqual([])
  })

  test('a backup publishes one archive object and becomes ready in the same transaction', async () => {
    const f = fixture()
    const receipt = await f.backups.backup.request({ includeWorktrees: false })
    const object = parseHostedBackupReference(receipt.path)
    const [row] = await f.rows()
    expect(row).toMatchObject({
      state: 'ready',
      activeSlot: null,
      objectId: object.id,
      sha256: object.sha256,
      sizeBytes: object.size,
      schemaDigest: logicalSchemaContract.digest,
      sourceGenerationId: 'dbg_hosted_backup_test',
    })
    expect(JSON.parse(row!.contentsJson!)).toEqual({ workflows: 3, skills: 2 })
    expect(receipt.contents).toEqual({ workflows: 3, skills: 2, db: true, config: true })
    // The archive pin is a deterministic lifetime: a restored catalog re-adopts it.
    expect(await f.publication(row!.id)).toMatchObject({ state: 'ready', attempt: row!.id })
    expect(f.pins).toHaveLength(1)
  })

  test('one building slot: a concurrent request is refused, a failed archive releases its slot', async () => {
    const f = fixture()
    const { hostedDatabaseBackups } = tablesOf(harness.db)
    await insertOne(harness.db, hostedDatabaseBackups, {
      id: '01a13e6d-3e00-7000-9e3c-0000000000c1',
      epoch: 1,
      kind: 'manual',
      state: 'building',
      activeSlot: 'global',
      createdAt: 1,
      updatedAt: 1,
    })
    await expect(f.backups.backup.request({ includeWorktrees: false })).rejects.toMatchObject({
      code: 'backup-in-progress',
    })
    // A building row of an earlier execution epoch can never complete, and a
    // failed archive export releases its own slot.
    f.rotate()
    f.failArchives()
    await expect(f.backups.backup.request({ includeWorktrees: false })).rejects.toThrow(
      'archive-export-failed',
    )
    const states = (await f.rows()).map((row) => row.state).sort()
    expect(states).toEqual(['failed', 'failed'])
    expect(f.pins).toEqual([])
  })

  test('prune releases catalog references only; the newest and the restore source are kept', async () => {
    const restoreSource = '01a13e6d-3e00-7000-9e3c-0000000000d1'
    const f = fixture({ protectedIds: [restoreSource] })
    const ready = async (id: string, kind: 'manual' | 'scheduled', createdAt: number) => {
      const { hostedDatabaseBackups } = tablesOf(harness.db)
      const { contentPublications } = tablesOf(harness.db)
      await insertOne(harness.db, hostedDatabaseBackups, {
        id,
        epoch: 1,
        kind,
        state: 'ready',
        objectId: '01a13e6d-3e00-7000-9e3c-0000000000ff',
        sha256: 'a'.repeat(64),
        sizeBytes: 10,
        schemaDigest: `sha256:${'b'.repeat(64)}`,
        sourceGenerationId: 'dbg_hosted_backup_test',
        contentsJson: '{"workflows":0,"skills":0}',
        snapshotAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      })
      await registerContentObjectInTx(
        harness.db,
        {
          version: 1,
          kind: 'object',
          location: { codec: 'hosted-object-id', value: '01a13e6d-3e00-7000-9e3c-0000000000ff' },
          contentId: `backup-content:${id}`,
          contentVersion: 1,
          sha256: 'a'.repeat(64),
          size: 10,
          mediaType: null,
        },
        createdAt,
      )
      await insertOne(harness.db, contentPublications, {
        id: hostedPublicationId(HOSTED_BACKUP_OWNER, id),
        owner: HOSTED_BACKUP_OWNER,
        logicalKey: id,
        attempt: id,
        state: 'ready',
        sha256: 'a'.repeat(64),
        size: 10,
        contentId: `backup-content:${id}`,
        epoch: 1,
        createdAt,
        updatedAt: createdAt,
      })
    }
    await ready(restoreSource, 'scheduled', 1)
    await ready('01a13e6d-3e00-7000-9e3c-0000000000d2', 'scheduled', 2)
    await ready('01a13e6d-3e00-7000-9e3c-0000000000d3', 'scheduled', 3)
    const result = await f.backups.maintenance.prune({ retentionCount: 1, retentionDays: 0 })
    expect(result).toEqual({ deleted: 1, kept: 2 })
    const byId = new Map((await f.rows()).map((row) => [row.id, row.state]))
    expect(byId.get(restoreSource)).toBe('ready')
    expect(byId.get('01a13e6d-3e00-7000-9e3c-0000000000d2')).toBe('released')
    expect(byId.get('01a13e6d-3e00-7000-9e3c-0000000000d3')).toBe('ready')
    expect(await f.publication('01a13e6d-3e00-7000-9e3c-0000000000d2')).toMatchObject({
      state: 'releasing',
    })
    // Pruning never calls the platform; maintenance unpins later.
    expect(f.releases).toEqual([])
    // Settled history is purged after its retention.
    f.advance(HOSTED_BACKUP_HISTORY_MS + 1)
    await f.backups.maintenance.prune({ retentionCount: 1, retentionDays: 0 })
    expect((await f.rows()).map((row) => row.id)).not.toContain(
      '01a13e6d-3e00-7000-9e3c-0000000000d2',
    )
  })

  test('the catalog verifies a ready backup with stat only and reports missing archives', async () => {
    const f = fixture({ protectedIds: [] })
    const receipt = await f.backups.backup.request({ includeWorktrees: false })
    const [row] = await f.rows()
    const listed = await f.catalog.list()
    expect(listed).toMatchObject({
      hasMore: false,
      backups: [{ id: row!.id, state: 'ready', protected: false }],
    })
    const verified = await f.catalog.verify(row!.id)
    expect(verified).toMatchObject({
      backupId: row!.id,
      reference: receipt.path,
      sizeBytes: row!.sizeBytes,
      workflows: 3,
      skills: 2,
    })
    await expect(f.catalog.verify('01a13e6d-3e00-7000-9e3c-0000000000e9')).rejects.toMatchObject({
      code: 'backup-not-found',
    })
    f.remove(row!.objectId!)
    await expect(f.catalog.verify(row!.id)).rejects.toMatchObject({
      code: 'backup-archive-unavailable',
    })
    const { hostedDatabaseBackups } = tablesOf(harness.db)
    await harness.db
      .update(hostedDatabaseBackups)
      .set({ state: 'released' })
      .where(eq(hostedDatabaseBackups.id, row!.id))
    await expect(f.catalog.verify(row!.id)).rejects.toMatchObject({ code: 'backup-not-ready' })
  })
})
