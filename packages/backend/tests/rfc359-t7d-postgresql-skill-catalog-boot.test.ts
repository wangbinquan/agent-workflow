// RFC-359 W1-T7d（P0-11）—— PostgreSQL daemon 也装配技能启动屏障。
//
// dual-provider-parity-audit-2026-09-04 P0-11：`composePostgresqlSkillCatalogBoot` 零生产调用方——
// 崩溃残留的 skill_operation_locks / reserving 行在 PG 上永远没人清（该技能永久保存不了、同名永远
// 建不了），`bootReverifyActivated` 恒 false 让损坏快照照常注入任务。SQLite 侧的接线顺序锁在
// rfc223-pr5-boot-restore-wiring.test.ts；这里给 PG daemon 同样的顺序锁，并在两个引擎上各跑一遍屏障。
//
// RFC-359 W4-D23c 起装配只剩一份（`composeSkillCatalogBoot`），两个 daemon 同一个入口，
// 下面的顺序锁与双引擎实跑照旧——它锁的是**接线顺序与可跑性**，与实现份数无关。

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { composeSkillCatalogBoot } from '@/modules/resource-catalog/composition/skillCatalogBoot'
import { isBootReverifyActive } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { describeEachProvider } from './helpers/eachProvider'

test('PostgreSQL daemon：屏障紧跟 restore、fail-closed、闸在 HTTP 之前，后台 reverify 在 HTTP 之后', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'cli', 'postgresqlDaemonApplication.ts'),
    'utf8',
  )
  const restore = source.indexOf('await core.systemOperations.applyPendingRestore()')
  const compose = source.indexOf('composeSkillCatalogBoot({', restore)
  const barrier = source.indexOf('skillCatalogBoot.runIdentityMigrationBarrier()', compose)
  const gate = source.indexOf('skillCatalogBoot.activateAvailabilityGate()', barrier)
  const reconcile = source.indexOf('skillCatalogBoot.reconcileLiveFiles()', gate)
  const httpCreate = source.indexOf('const app = createComposedApp', gate)
  const backfill = source.indexOf('skillCatalogBoot.backfillLegacyVersions()', httpCreate)
  const reverify = source.indexOf('skillCatalogBoot.reverifySnapshots()', backfill)
  expect(restore).toBeGreaterThan(-1)
  expect(compose).toBeGreaterThan(restore)
  expect(barrier).toBeGreaterThan(compose)
  expect(gate).toBeGreaterThan(barrier)
  expect(reconcile).toBeGreaterThan(gate)
  expect(httpCreate).toBeGreaterThan(reconcile)
  expect(backfill).toBeGreaterThan(httpCreate)
  expect(reverify).toBeGreaterThan(backfill)
  // 屏障与闸之间不许有 best-effort 兜底：身份证明失败不能变成一个活着的 daemon。
  expect(source.slice(restore, gate)).not.toContain('try {')
  expect(source.slice(restore, gate)).not.toContain('catch')
})

describeEachProvider('RFC-359 T7d —— 技能启动屏障在两个引擎上各跑一遍', (harness) => {
  test('空目录上屏障 / 闸 / 对齐 / 回填 / reverify 全部可跑，闸激活后 boot reverify 生效', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc359-skill-boot-'))
    mkdirSync(join(tmp, 'skills'), { recursive: true })
    try {
      // W4-D23c：不再按引擎分叉装配——同一个 `composeSkillCatalogBoot` 两个引擎各跑一遍。
      const boot = composeSkillCatalogBoot({ db: harness.db, appHome: tmp })
      const report = await boot.runIdentityMigrationBarrier()
      expect(report).toMatchObject({ recoveredOperations: 0, removedHusks: 0, migratedSkills: 0 })
      boot.activateAvailabilityGate()
      expect(isBootReverifyActive()).toBe(true)
      await boot.reconcileLiveFiles()
      expect(await boot.backfillLegacyVersions()).toMatchObject({ backfilled: 0, husksRemoved: 0 })
      expect(await boot.reverifySnapshots()).toMatchObject({ verified: 0, quarantined: 0 })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
