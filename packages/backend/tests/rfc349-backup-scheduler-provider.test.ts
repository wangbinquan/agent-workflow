// RFC-349 T6 — scheduled backups are dispatched through the active provider
// operation. PostgreSQL composition must not manufacture a SQLite DbClient or
// fall back to the retained pre-cutover SQLite generation.
//
// RFC-359 W8：本用例原本驱动的是一个零生产调用方的 PostgreSQL 定时备份适配器，已随死适配器一批删除，
// 断言改指生产路径：注入了 provider 备份操作的 ticker 全程不碰 DbClient。
//
// RFC-426：旧断言是「每拍都按 `{ kind: 'scheduled', appHome }` 调用注入的函数」，而生产注入的单机 PostgreSQL
// 函数把这个参数丢掉、改走手动备份命令，定时备份因此落成手动家族——断言过了，缺陷没被看见。现在定时备份
// 是什么、落到哪里由系统运维模块决定（`SystemOperationsModule.scheduledBackup`，见
// `rfc426-scheduled-backup-source.test.ts`），定时器只管节拍：每拍无参调用一次注入的函数。

import { describe, expect, test } from 'bun:test'
import { startBackupScheduler } from '@/platform/background/providerBackupScheduler'

describe('RFC-349 provider-aware backup scheduler', () => {
  test('runs an injected provider backup without requiring a SQLite client', async () => {
    const appHome = '/provider-owned/application-home'
    const calls: unknown[][] = []
    let observed!: () => void
    const firstCall = new Promise<void>((resolve) => {
      observed = resolve
    })

    const scheduler = startBackupScheduler({
      intervalMs: 30,
      retentionCount: 3,
      retentionDays: 7,
      pruneMode: 'external',
      // 生产形状：注入部署的定时备份（系统运维模块的参与者），定时器没有 SQLite 客户端分支。
      createScheduledBackup: async (...request: unknown[]) => {
        calls.push(request)
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

    // ticker 每拍无参调用一次注入的备份；没有任何 SQLite 客户端参与。
    expect(calls).toEqual([[]])
  })
})
