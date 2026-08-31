// RFC-349 T6 — scheduled backups are dispatched through the active provider
// operation. PostgreSQL composition must not manufacture a SQLite DbClient or
// fall back to the retained pre-cutover SQLite generation.

import { describe, expect, test } from 'bun:test'
import { startBackupScheduler } from '@/services/backupScheduler'

describe('RFC-349 provider-aware backup scheduler', () => {
  test('runs an injected provider backup without requiring a SQLite client', async () => {
    const appHome = '/provider-owned/application-home'
    const calls: Array<{ kind: 'scheduled'; appHome: string }> = []
    let observed!: () => void
    const firstCall = new Promise<void>((resolve) => {
      observed = resolve
    })

    const scheduler = startBackupScheduler({
      intervalMs: 30,
      retentionCount: 3,
      retentionDays: 7,
      pruneMode: 'external',
      async createScheduledBackup(input) {
        calls.push(input)
        observed()
      },
      appHome,
    })

    await firstCall
    scheduler.stop()
    await Bun.sleep(60)

    expect(calls).toEqual([{ kind: 'scheduled', appHome }])
  })
})
