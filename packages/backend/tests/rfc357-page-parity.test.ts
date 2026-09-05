// RFC-357 —— 共享场景在 **SQLite** 上的那一遍。
//
// 与 `rfc357-postgresql-page.integration.test.ts` 调的是**同一个** `expectRfc357PageScenario`
// ——两个 provider 的行为对齐因此是结构性的，不是「各写一份断言再人肉对照」。这一遍在普通
// backend 跑批里跑；另一遍在 CI 的 postgres lane 上对着真库跑。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { composeSqliteOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import { createDatabaseTaskListPage } from '@/modules/task-execution/infrastructure/taskListPage'

import { seedRfc357Page } from './helpers/rfc357PageSeed'
import { expectRfc357PageScenario, RFC357_ADMIN } from './helpers/rfc357PageScenario'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-357 shared page scenario — SQLite', () => {
  test('the whole scenario holds', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedRfc357Page(db)
    await expectRfc357PageScenario(
      createDatabaseTaskListPage(db, composeSqliteOwnerIdentityQueries(db)),
    )
  })

  // 场景本身必须有预言力：如果它在一个空库上也「通过」，那 PostgreSQL 那一遍
  // 就成了摆设。这条用空库把场景钉成会红的。
  test('the scenario has teeth — it fails against an unseeded database', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const page = createDatabaseTaskListPage(db, composeSqliteOwnerIdentityQueries(db))
    let threw = false
    try {
      await expectRfc357PageScenario(page)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect((await page.list(RFC357_ADMIN, {})).items).toEqual([])
  })
})
