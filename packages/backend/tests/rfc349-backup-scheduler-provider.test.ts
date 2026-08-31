// RFC-349 T6 — scheduled backups are dispatched through the active provider
// operation. PostgreSQL composition must not manufacture a SQLite DbClient or
// fall back to the retained pre-cutover SQLite generation.

import { describe, expect, test } from 'bun:test'
import { createPostgresqlScheduledBackupRequester } from '@/modules/system-operations/infrastructure/postgresqlProviderBackup'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { startBackupScheduler } from '@/services/backupScheduler'

describe('RFC-349 provider-aware backup scheduler', () => {
  test('runs an injected provider backup without requiring a SQLite client', async () => {
    const appHome = '/provider-owned/application-home'
    const calls: Array<Record<string, unknown>> = []
    let observed!: () => void
    const firstCall = new Promise<void>((resolve) => {
      observed = resolve
    })

    const scheduler = startBackupScheduler({
      intervalMs: 30,
      retentionCount: 3,
      retentionDays: 7,
      pruneMode: 'external',
      createScheduledBackup: createPostgresqlScheduledBackupRequester({
        options: {
          runtime: {
            provider: 'postgresql',
            generationId: 'dbg_pg_scheduled_backup_01',
          } as PostgresqlDatabaseRuntime,
        },
        async createBackup(input) {
          calls.push(input as unknown as Record<string, unknown>)
          observed()
          return {
            path: '/provider-owned/application-home/backups/scheduled.tar.gz',
            sizeBytes: 1,
            contents: { workflows: 0, skills: 0, config: false, db: true },
          }
        },
      }),
      appHome,
    })

    await firstCall
    scheduler.stop()
    await Bun.sleep(60)

    expect(calls).toEqual([
      {
        runtime: {
          provider: 'postgresql',
          generationId: 'dbg_pg_scheduled_backup_01',
        },
        kind: 'scheduled',
        includeWorktrees: false,
        appHome,
      },
    ])
  })
})
