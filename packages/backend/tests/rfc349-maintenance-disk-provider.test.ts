import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { drizzle } from 'drizzle-orm/bun-sqlite'
import {
  composePostgresqlMaintenanceDiskOperations,
  composeSqliteMaintenanceDiskOperations,
} from '@/modules/system-operations/composition/maintenanceDisk'

import { describeEachProvider } from './helpers/eachProvider'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-349 maintenance disk provider operations', () => {
  test('SQLite reports freelist pages through its provider adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-maintenance-disk-sqlite-'))
    roots.push(root)
    const native = new Database(join(root, 'db.sqlite'))
    native.exec('CREATE TABLE fixture (id TEXT PRIMARY KEY);')
    const operations = composeSqliteMaintenanceDiskOperations(drizzle(native), root)

    expect(await operations.report()).toMatchObject({
      items: [{ id: 'retired-runtime-stores', exists: false }],
      dbFreelistBytes: 0,
    })
    native.close()
  })
})

// RFC-359 AC-6（plan §5go）—— PostgreSQL 那格原来喂的是**假池**：`unsafe` 把 SQL 收进数组、
// 回一组罐头的 `{ database_bytes: '4096', reclaimable_bytes: '512' }`，然后断言「SQL 文本里
// 出现过 pg_stat_user_tables」。那条断言验的是**我们自己拼的字符串**——目录查询写错列名、
// 写错函数、schema 限定漏了，假池一律照过。
//
// 改成在**真 PostgreSQL** 上跑：`harness.applicationBinding` 在 PG 那侧直接交出真的
// `InstrumentedPostgresqlDatabaseRuntime`，正是 `composePostgresqlMaintenanceDiskOperations`
// 要的入参。于是那句目录查询**真的被执行**，写错当场报错。
//
// 为什么只在 PG 那条 lane 跑、而不把上面那格 SQLite 也并进来：两侧的**资源形态**不同
// （§5fq ②）——SQLite 的 freelist / 文件字节数要一个**真文件库**才有意义
// （上面那格用的就是 `new Database(<file>)`），PostgreSQL 是服务端目录统计。
// 同一个被测面在两个引擎上问的本来就是两个不同的东西，不该硬塞进一组断言。
describeEachProvider(
  'RFC-349 maintenance disk provider operations（PostgreSQL 真库）',
  (harness) => {
    test('PostgreSQL 在真目录上报出存储用量，且不掺任何 SQLite 机制', async () => {
      if (harness.capabilities.provider !== 'postgresql') return
      const binding = harness.applicationBinding
      if (binding.provider !== 'postgresql') return

      const root = mkdtempSync(join(tmpdir(), 'rfc349-maintenance-disk-postgresql-'))
      roots.push(root)
      const retired = join(root, 'opencode-stores')
      mkdirSync(retired)
      writeFileSync(join(retired, 'stale.bin'), 'fixture')

      const operations = composePostgresqlMaintenanceDiskOperations(binding.runtime, root)
      const report = await operations.report()

      // 退役目录那部分是纯文件系统，数值仍然是确定的。
      expect(report).toMatchObject({
        items: [{ id: 'retired-runtime-stores', exists: true, bytes: 7, entries: 1 }],
      })
      // 库那部分来自真目录统计：具体字节数随实例而变，能断言的是**它真的问出来了**
      // ——是数、非负、而且 `dbFileBytes` 至少有一个空库的体量。
      expect(Number.isFinite(report.dbFileBytes)).toBe(true)
      expect(report.dbFileBytes).toBeGreaterThan(0)
      expect(Number.isFinite(report.dbFreelistBytes)).toBe(true)
      expect(report.dbFreelistBytes).toBeGreaterThanOrEqual(0)

      expect(await operations.cleanupRetiredStores()).toEqual({ removedBytes: 7 })
    })
  },
)
