// RFC-349 — the existing System Operations backup command must project to the
// live PostgreSQL provider adapter without exposing provider details publicly.

import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { describe, expect, test } from 'bun:test'
import { createPostgresqlAdminBackupCoordinator } from '@/modules/system-operations/infrastructure/postgresqlAdminBackupCoordinator'
import type { CreatePostgresqlProviderBackupOptions } from '@/modules/system-operations/infrastructure/postgresqlProviderBackup'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { SCHEDULED_BACKUP_REQUEST } from '@/modules/system-operations/domain/backup'

/** 协调器只把它转交给资产工厂；本文件的判据都在协调器这一层，不碰任何一条查询。 */
const NEUTRAL_DATABASE = {} as PersistenceDb
/** 同理：运行时只是转交给（被 stub 掉的）provider 备份的身份，不经它发任何 SQL。 */
const ADMIN_BACKUP_RUNTIME = {
  provider: 'postgresql',
  generationId: 'dbg_pg_admin_backup_01',
} as PostgresqlDatabaseRuntime

describe('RFC-349 PostgreSQL admin backup coordinator', () => {
  test('prepares application assets then requests one provider backup', async () => {
    const calls: string[] = []
    const runtime = ADMIN_BACKUP_RUNTIME
    let received: CreatePostgresqlProviderBackupOptions | undefined
    const coordinator = createPostgresqlAdminBackupCoordinator({
      headContract: logicalSchemaContract,
      contract: logicalSchemaContract,
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
      headContract: logicalSchemaContract,
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
      headContract: logicalSchemaContract,
      contract: logicalSchemaContract,
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

  // RFC-426: the scheduled request reaches the provider backup with its kind. Before RFC-426 this coordinator dropped
  // the kind, so standalone PostgreSQL scheduled backups were written as manual `agent-workflow-*` archives.
  test('hands the scheduled kind and the worktree choice to the provider backup', async () => {
    const received: CreatePostgresqlProviderBackupOptions[] = []
    const coordinator = createPostgresqlAdminBackupCoordinator({
      headContract: logicalSchemaContract,
      contract: logicalSchemaContract,
      runtime: ADMIN_BACKUP_RUNTIME,
      db: NEUTRAL_DATABASE,
      appHome: '/provider-owned/application-home',
      async createBackup(options) {
        received.push(options)
        return {
          path: '/provider-owned/application-home/backups/scheduled.tar.gz',
          sizeBytes: 1,
          contents: { workflows: 0, skills: 0, config: true, db: true },
        }
      },
    })
    await coordinator.request(SCHEDULED_BACKUP_REQUEST)
    await coordinator.request({ includeWorktrees: true })
    expect(received.map(({ kind, includeWorktrees }) => ({ kind, includeWorktrees }))).toEqual([
      { kind: 'scheduled', includeWorktrees: false },
      { kind: undefined, includeWorktrees: true },
    ])
  })
})
