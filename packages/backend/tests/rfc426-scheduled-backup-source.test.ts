// RFC-426: a scheduled backup is the deployment's backup asked for `SCHEDULED_BACKUP_REQUEST` (the rotatable `scheduled`
// family without worktrees, `docs/disaster-recovery.md` §1.2 / §6), and the daemon's backup ticker only keeps the beat.
// SQLite keeps its in-process snapshot (moved from the ticker into the SQLite recovery adapter, still without the backup
// preparation step). The PostgreSQL side — hosted platform backup, local coordinator, the scheduled kind reaching the
// provider backup — is locked next to its fixtures in `rfc349-postgresql-system-operations-composition`,
// `rfc349-postgresql-admin-backup` and `rfc349-postgresql-provider-backup`.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { openDb } from '@/db/client'
import { composeSystemOperations } from '@/modules/system-operations/composition'
import type { AdminBackupReceipt } from '@/modules/system-operations/domain/backup'
import { createLegacyPlatformRecoveryAdapter } from '@/modules/system-operations/infrastructure/legacyPlatformRecoveryAdapter'
import type { RestoreArtifactPathResolver } from '@/modules/system-operations/infrastructure/restoreArtifactIngress'
import type { BackupOptions } from '@/platform/persistence/sqlite/systemProviderBackup'
import { readManifest } from '@/platform/persistence/sqlite/systemBackupManifest'
import { extractTarGz } from '@/util/archive'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const RECEIPT: AdminBackupReceipt = {
  path: '/backups/receipt.tar.gz',
  sizeBytes: 1,
  contents: { workflows: 0, skills: 0, db: true, config: true },
}

describe('RFC-426 SQLite: the scheduled backup stays an in-process snapshot', () => {
  test('the recovery adapter passes the request kind and snapshots scheduled backups without preparation', async () => {
    const calls: BackupOptions[] = []
    let prepared = 0
    const db = {} as BackupOptions['db']
    const adapter = createLegacyPlatformRecoveryAdapter({
      contract: logicalSchemaContract,
      artifacts: {} as RestoreArtifactPathResolver,
      backupResources: () => ({ db }),
      prepareBackup: async () => {
        prepared += 1
      },
      appHome: '/sqlite-home',
      dbPath: '/sqlite-home/db.sqlite',
      lockPath: '/sqlite-home/.daemon.lock',
      resolveRestoreMigrations: async () => '',
      mechanisms: {
        async createBackup(options) {
          calls.push(options)
          return RECEIPT
        },
      },
    })

    await adapter.backup.request({ includeWorktrees: true, kind: 'manual' })
    await adapter.scheduledBackup()
    expect(
      calls.map(({ kind, includeWorktrees, appHome }) => ({ kind, includeWorktrees, appHome })),
    ).toEqual([
      { kind: 'manual', includeWorktrees: true, appHome: '/sqlite-home' },
      { kind: 'scheduled', includeWorktrees: false, appHome: '/sqlite-home' },
    ])
    expect(calls[1]!.db).toBe(db)
    // Unchanged by RFC-426: only the requested (manual) path runs the preparation step.
    expect(prepared).toBe(1)
  })

  test('a real SQLite module writes a scheduled-* archive without worktrees', async () => {
    const appHome = tempRoot('rfc426-sqlite-')
    const db = openDb({ path: join(appHome, 'db.sqlite') })
    let prepared = 0
    try {
      const module = composeSystemOperations({
        contract: logicalSchemaContract,
        db,
        secretBox: undefined,
        repositoryBackupPreparation: {
          async prepare() {
            prepared += 1
            return { sealed: 0, linked: 0, scrubbed: 0 }
          },
        },
        appHome,
      })
      const result = (await module.scheduledBackup()) as { readonly path: string }
      expect(basename(result.path).startsWith('scheduled-')).toBe(true)
      const extracted = tempRoot('rfc426-sqlite-out-')
      await extractTarGz(result.path, extracted)
      expect(existsSync(join(extracted, 'worktrees'))).toBe(false)
      expect(readManifest(extracted)).toMatchObject({ kind: 'scheduled', includesWorktrees: false })
      expect(prepared).toBe(0)
    } finally {
      ;(db as unknown as { $client: { close(): void } }).$client.close()
    }
  })
})
