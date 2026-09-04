// RFC-359 W3-T15 —— 两个 daemon 入口的 boot 步骤必须同序、同一份实现。
//
// dual-provider-parity-audit-2026-09-04 T15：多数 PG 适配器已写好且已接进 persistence，只是没人调——
// 回收策略注册（P1-12）、融合三步、定时载荷治愈、数字员工模板、demo 播种、runtime 注册表 boot、
// webhook 投递恢复在 PG daemon 上一步都没跑。这里不复述每一步的行为（各自有测试），只锁「两个入口
// 都调、且相对顺序一致」：任何一侧新增 / 挪动一步而另一侧没跟上，这里就红。

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const cli = resolve(import.meta.dir, '..', 'src', 'cli')
const SQLITE_ENTRY = readFileSync(resolve(cli, 'start.ts'), 'utf8')
const POSTGRESQL_ENTRY = readFileSync(resolve(cli, 'postgresqlDaemonApplication.ts'), 'utf8')

/** 两个入口都必须出现、且相对顺序必须一致的 boot 标记（按 cli/start.ts 的顺序列出）。 */
const ORDERED_BOOT_MARKERS = [
  'registerTerminalWorkspacePrunePolicy(',
  'cleanupOrphanedGitCredentialLeases(',
  'skillCatalogBoot.runIdentityMigrationBarrier()',
  'repairFusionProvenance(',
  'await runTaskExecutionBootRecovery({',
  'await recoverInterruptedTaskDeletes(',
  'healScheduledLaunchPayloads(',
  'recoverFusionDecisions(',
  'seedFusionResources(',
  'await ensureDigitalEmployeeAgentTemplates(',
  'seedDemoContent({',
  'const app = createComposedApp',
] as const

function positions(source: string, markers: readonly string[]): number[] {
  return markers.map((marker) => {
    const at = source.indexOf(marker)
    expect(at, `missing boot marker: ${marker}`).toBeGreaterThan(-1)
    return at
  })
}

function isStrictlyIncreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > values[index - 1]!)
}

test('cli/start.ts（SQLite）按登记顺序跑这些 boot 步骤', () => {
  expect(isStrictlyIncreasing(positions(SQLITE_ENTRY, ORDERED_BOOT_MARKERS))).toBe(true)
})

test('postgresqlDaemonApplication.ts 跑同一组 boot 步骤，且相对顺序与 SQLite 一致', () => {
  expect(isStrictlyIncreasing(positions(POSTGRESQL_ENTRY, ORDERED_BOOT_MARKERS))).toBe(true)
})

test('webhook 投递恢复紧跟终态控制 reconcileOnBoot，两个入口同形', () => {
  for (const source of [SQLITE_ENTRY, POSTGRESQL_ENTRY]) {
    const reconcile = source.indexOf('await webhookTerminalControl.reconcileOnBoot()')
    const deliveries = source.indexOf('await recoverInterruptedDeliveries(', reconcile)
    const httpCreate = source.indexOf('const app = createComposedApp')
    expect(reconcile).toBeGreaterThan(-1)
    expect(deliveries).toBeGreaterThan(reconcile)
    expect(httpCreate).toBeGreaterThan(deliveries)
  }
})

test('PG daemon：融合 provenance 修复 fail-closed（不包 try），且在任何融合恢复 / 播种之前', () => {
  const repair = POSTGRESQL_ENTRY.indexOf('repairFusionProvenance(')
  const block = POSTGRESQL_ENTRY.slice(
    POSTGRESQL_ENTRY.lastIndexOf('\n  {', repair),
    POSTGRESQL_ENTRY.indexOf('\n  }', repair) + 4,
  )
  expect(block).not.toContain('try {')
  expect(block).not.toContain('catch')
  expect(POSTGRESQL_ENTRY.indexOf('recoverFusionDecisions(')).toBeGreaterThan(repair)
  expect(POSTGRESQL_ENTRY.indexOf('seedFusionResources(')).toBeGreaterThan(repair)
})

test('runtime 注册表 boot 每条 provider 路径恰好一次：SQLite 在 start.ts 主路径，PG 在 provider 会话建立时', () => {
  const marker = 'await initializeRuntimeRegistryBoot({'
  const sqliteEntryCalls = SQLITE_ENTRY.split(marker).length - 1
  // start.ts 里两处：composePostgresqlProviderSession（PG 路径）与 SQLite 主路径各一次。
  expect(sqliteEntryCalls).toBe(2)
  const providerSession = SQLITE_ENTRY.indexOf('async function composePostgresqlProviderSession(')
  const serve = SQLITE_ENTRY.indexOf('async function servePostgresqlDaemon(')
  const first = SQLITE_ENTRY.indexOf(marker)
  expect(first).toBeGreaterThan(providerSession)
  expect(first).toBeLessThan(serve)
  // PG daemon 装配里不得再跑一次（否则内置 runtime 行会被重复播种 / 回填）。
  expect(POSTGRESQL_ENTRY).not.toContain(marker)
})
