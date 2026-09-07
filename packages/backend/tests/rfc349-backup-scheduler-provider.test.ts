// RFC-349 T6 — scheduled backups are dispatched through the active provider
// operation. PostgreSQL composition must not manufacture a SQLite DbClient or
// fall back to the retained pre-cutover SQLite generation.
//
// RFC-359 W8：本用例原本驱动的是
// `modules/system-operations/infrastructure/postgresqlProviderBackup.ts::createPostgresqlScheduledBackupRequester`
// ——一个**零生产调用方**的适配器（`tests/architecture/rfc359-w5-adapter-production-consumer.test.ts`
// 的「改指」账本记的就是它），已随死适配器一批删除。生产上定时备份走的是
// `cli/start.ts:891` 的中立命令注入：`startBackupScheduler({ createScheduledBackup: () =>
// systemOperations.application.commands.requestBackup.execute(...) })`。所以断言改指那条真路径，
// 锁的判据不变——注入了 provider 备份操作的 ticker 全程不碰 DbClient，且每拍都按
// `{ kind: 'scheduled', appHome }` 调用注入的命令。

import { describe, expect, test } from 'bun:test'
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
      // 生产形状：注入一个 provider 中立的备份命令，`db` 一栏根本不传。
      createScheduledBackup: async (request) => {
        calls.push(request as unknown as Record<string, unknown>)
        observed()
        return {
          path: '/provider-owned/application-home/backups/scheduled.tar.gz',
          sizeBytes: 1,
          contents: { workflows: 0, skills: 0, config: false, db: true },
        }
      },
      appHome,
    })

    await firstCall
    scheduler.stop()
    await Bun.sleep(60)

    // ticker 把归档家族与 appHome 一起交给注入的命令；没有任何 SQLite 客户端参与。
    expect(calls).toEqual([{ kind: 'scheduled', appHome }])
  })
})
