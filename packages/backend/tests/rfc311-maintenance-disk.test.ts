// RFC-311 T20 —— 可回收空间的盘点、清理与 `db compact`。
//
// 审计量到的磁盘全景里，`opencode-stores/` 是 RFC-276 退役留下的**零引用死数据**
// （本机 2.9GB，全仓无任何代码读写它，也没有任何东西会清理它）；DB 内部的空洞是
// `freelist_count × page_size`——归档/保留期清理删掉的页留在文件里，只有 VACUUM
// 能还给文件系统。
//
// 锁四件事：
//   1. 盘点是**只读**的（看过之后目录必须还在——否则「看一眼」就删了数据）；
//   2. 清理真的删、且重复调用无害（用户会连点）；
//   3. freelist 数字随删除上升、随 VACUUM 归零（否则这个提示是假的）；
//   4. `db compact` 在 daemon 运行时**拒绝执行**（VACUUM 持写锁重写整库 = 全站冻结）。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sql } from 'drizzle-orm'

import { openDb } from '../src/db/client'
import { cleanupRetiredStores, reportDiskReclaimable } from '../src/services/maintenanceDisk'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedRetiredStores(home: string): void {
  const dir = join(home, 'opencode-stores', 'abcdef', 'storage')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'blob-1.bin'), 'x'.repeat(4_096))
  writeFileSync(join(dir, 'blob-2.bin'), 'y'.repeat(2_048))
}

describe('RFC-311 T20 — reclaimable disk report and cleanup', () => {
  test('the report is read-only, cleanup is idempotent, and freelist tracks VACUUM', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aw-rfc311-disk-'))
    try {
      const db = openDb({ path: join(home, 'db.sqlite'), migrationsFolder: MIGRATIONS })
      seedRetiredStores(home)

      const first = reportDiskReclaimable(db, home)
      const stores = first.items.find((i) => i.id === 'retired-runtime-stores')!
      expect(stores.exists).toBe(true)
      expect(stores.bytes).toBe(6_144)
      expect(stores.entries).toBeGreaterThan(0)
      // ① 盘点只读:目录必须原样还在。
      expect(existsSync(stores.path)).toBe(true)
      expect(first.dbFileBytes).toBeGreaterThan(0)

      // ③ freelist:先塞一张大表再删,页会进 freelist;VACUUM 之后归零。
      db.run(sql.raw('CREATE TABLE t20_scratch (id INTEGER PRIMARY KEY, blob TEXT)'))
      db.run(
        sql.raw(
          `INSERT INTO t20_scratch (blob) SELECT hex(randomblob(400)) FROM
             (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<4000) SELECT x FROM c)`,
        ),
      )
      db.run(sql.raw('DROP TABLE t20_scratch'))
      const afterDrop = reportDiskReclaimable(db, home)
      expect(afterDrop.dbFreelistBytes).toBeGreaterThan(0)
      db.run(sql.raw('VACUUM'))
      expect(reportDiskReclaimable(db, home).dbFreelistBytes).toBe(0)

      // ② 清理真的删,重复调用无害。
      const removed = cleanupRetiredStores(home)
      expect(removed.removedBytes).toBe(6_144)
      expect(existsSync(stores.path)).toBe(false)
      expect(cleanupRetiredStores(home).removedBytes).toBe(0)

      const after = reportDiskReclaimable(db, home)
      expect(after.items[0]!.exists).toBe(false)
      expect(after.items[0]!.bytes).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('db compact refuses to run while the daemon holds the lock', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aw-rfc311-compact-'))
    const prevHome = process.env.AGENT_WORKFLOW_HOME
    try {
      process.env.AGENT_WORKFLOW_HOME = home
      openDb({ path: join(home, 'db.sqlite'), migrationsFolder: MIGRATIONS })
      // 伪造一个「daemon 在跑」的锁:写进本进程自己的 pid,它显然活着。
      writeFileSync(join(home, '.daemon.lock'), String(process.pid))

      const { dbCompactCommand } = await import('../src/cli/dbCompact')
      const blocked = dbCompactCommand()
      expect(blocked.status).toBe('daemon-running')
      expect(blocked.output).toContain('agent-workflow stop')

      // 锁清掉之后才允许执行。
      rmSync(join(home, '.daemon.lock'))
      const ok = dbCompactCommand()
      expect(ok.status).toBe('ok')
      expect(ok.output).toContain('compacted')
    } finally {
      if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
