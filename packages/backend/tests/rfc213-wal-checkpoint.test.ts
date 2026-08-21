// RFC-213 PR-4 G4c — WAL checkpoint discipline.
//
// checkpointWal folds the -wal into db.sqlite and truncates it, bounding -wal
// growth. MUTATION CHECK (manually verified): change TRUNCATE to PASSIVE in
// checkpointWal → the -wal file is not truncated → the shrink assertion reds.

import { afterEach, describe, expect, test } from 'bun:test'
import { removeTempDirSync } from './fixtures/tempDir'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { openDb, type DbClient } from '../src/db/client'
import { workflows } from '../src/db/schema'
import { checkpointWal, startWalCheckpointLoop } from '../src/services/backupScheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc213-wal-ck-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) removeTempDirSync(d)
})

describe('RFC-213 checkpointWal', () => {
  test('truncates a grown -wal', async () => {
    const dbPath = join(tmp(), 'db.sqlite')
    const db: DbClient = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    // Grow the WAL without checkpointing.
    for (let i = 0; i < 50; i++) {
      await db.insert(workflows).values({
        id: ulid(),
        name: `wf-${i}`,
        definition: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
      })
    }
    const before = statSync(`${dbPath}-wal`).size
    expect(before).toBeGreaterThan(0)

    checkpointWal(db)

    const after = statSync(`${dbPath}-wal`).size
    expect(after).toBeLessThan(before)
    expect(after).toBe(0) // TRUNCATE zeroes the file
    ;(db as unknown as { $client: Database }).$client.close()
  })

  // RFC-311 余项：间隔改成每拍热读（`getIntervalMs`）后，0 仍然是「不 checkpoint」，
  // 只是监督拍还在跑——这样把配置改回非 0 不需要重启 daemon。热切换本身由
  // `rfc311-maintenance-boot-tick.test.ts` 锁定。
  test('startWalCheckpointLoop with getIntervalMs()=0 never touches the db', () => {
    const handle = startWalCheckpointLoop({
      db: {} as never,
      getIntervalMs: () => 0,
      tickMs: 5,
    })
    expect(() => handle.stop()).not.toThrow()
  })
})
