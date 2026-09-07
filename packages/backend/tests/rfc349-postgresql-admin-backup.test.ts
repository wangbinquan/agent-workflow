// RFC-349 — the existing System Operations backup command must project to the
// live PostgreSQL provider adapter without exposing provider details publicly.

import { describe, expect, test } from 'bun:test'
import { createPostgresqlAdminBackupCoordinator } from '@/modules/system-operations/infrastructure/postgresqlAdminBackupCoordinator'
import type { CreatePostgresqlProviderBackupOptions } from '@/modules/system-operations/infrastructure/postgresqlProviderBackup'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'

/** 协调器只把它转交给资产工厂；本文件的判据都在协调器这一层，不碰任何一条查询。 */
const NEUTRAL_DATABASE = {} as ProviderNeutralDatabase

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
      db: NEUTRAL_DATABASE,
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
    expect(received).toMatchObject({
      runtime,
      appHome: '/provider-owned/application-home',
      includeWorktrees: true,
    })
    // RFC-359 W9：应用侧资产由协调器用中立客户端装配一次，再交给 provider 备份。
    expect(typeof received?.application.exportWorkflows).toBe('function')
    expect(typeof received?.application.captureWorktrees).toBe('function')
  })

  test('does not start a provider backup when preparation fails', async () => {
    let backups = 0
    const coordinator = createPostgresqlAdminBackupCoordinator({
      runtime: {
        provider: 'postgresql',
        generationId: 'dbg_pg_admin_backup_02',
      } as PostgresqlDatabaseRuntime,
      db: NEUTRAL_DATABASE,
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
