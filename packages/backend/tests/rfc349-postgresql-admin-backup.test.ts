// RFC-349 — the existing System Operations backup command must project to the
// live PostgreSQL provider adapter without exposing provider details publicly.

import { describe, expect, test } from 'bun:test'
import { createPostgresqlAdminBackupCoordinator } from '@/modules/system-operations/infrastructure/postgresqlAdminBackupCoordinator'
import type { CreatePostgresqlProviderBackupOptions } from '@/modules/system-operations/infrastructure/postgresqlProviderBackup'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'

describe('RFC-349 PostgreSQL admin backup coordinator', () => {
  test('prepares application assets then requests one provider backup', async () => {
    const calls: string[] = []
    const runtime = {
      provider: 'postgresql',
      generationId: 'dbg_pg_admin_backup_01',
    } as PostgresqlDatabaseRuntime
    let received: CreatePostgresqlProviderBackupOptions | undefined
    const coordinator = createPostgresqlAdminBackupCoordinator({
      runtime,
      appHome: '/provider-owned/application-home',
      prepare() {
        calls.push('prepare')
      },
      async createBackup(options) {
        calls.push('backup')
        received = options
        return {
          path: '/provider-owned/application-home/backups/agent-workflow.tar.gz',
          sizeBytes: 42,
          contents: { workflows: 3, skills: 2, config: true, db: true },
        }
      },
    })

    await expect(coordinator.request({ includeWorktrees: true })).resolves.toEqual({
      path: '/provider-owned/application-home/backups/agent-workflow.tar.gz',
      sizeBytes: 42,
      contents: { workflows: 3, skills: 2, config: true, db: true },
    })
    expect(calls).toEqual(['prepare', 'backup'])
    expect(received).toEqual({
      runtime,
      appHome: '/provider-owned/application-home',
      includeWorktrees: true,
    })
  })

  test('does not start a provider backup when preparation fails', async () => {
    let backups = 0
    const coordinator = createPostgresqlAdminBackupCoordinator({
      runtime: {
        provider: 'postgresql',
        generationId: 'dbg_pg_admin_backup_02',
      } as PostgresqlDatabaseRuntime,
      appHome: '/provider-owned/application-home',
      prepare() {
        throw new Error('application backup preparation failed')
      },
      async createBackup() {
        backups += 1
        throw new Error('must not run')
      },
    })

    await expect(coordinator.request({ includeWorktrees: false })).rejects.toThrow(
      'application backup preparation failed',
    )
    expect(backups).toBe(0)
  })
})
