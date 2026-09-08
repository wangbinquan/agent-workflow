// RFC-357 / RFC-359 AC6 —— 原共享场景默认在两个真实 provider 上执行。
//
// 与 `rfc357-postgresql-page.integration.test.ts` 调的是**同一个** `expectRfc357PageScenario`
// ——两个 provider 复用原场景和原空库反例；push CI 的默认双库 lane 两者都执行。

import { expect, test } from 'bun:test'

import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import { createDatabaseTaskListPage } from '@/modules/task-execution/infrastructure/taskListPage'

import { seedRfc357Page } from './helpers/rfc357PageSeed'
import { expectRfc357PageScenario, RFC357_ADMIN } from './helpers/rfc357PageScenario'

import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-357 shared page scenario', (harness) => {
  test('the whole scenario holds', async () => {
    const db = harness.db
    await seedRfc357Page(db)
    await expectRfc357PageScenario(createDatabaseTaskListPage(db, composeOwnerIdentityQueries(db)))
  })

  // 场景本身必须有预言力：如果它在一个空库上也「通过」，那 PostgreSQL 那一遍
  // 就成了摆设。这条用空库把场景钉成会红的。
  test('the scenario has teeth — it fails against an unseeded database', async () => {
    const db = harness.db
    const page = createDatabaseTaskListPage(db, composeOwnerIdentityQueries(db))
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
