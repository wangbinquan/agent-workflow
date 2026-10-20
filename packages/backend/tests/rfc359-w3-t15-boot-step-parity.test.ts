// RFC-359 W3-T15 —— 两个 daemon 入口的 boot 步骤必须同序、同一份实现。
//
// dual-provider-parity-audit-2026-09-04 T15：多数 PG 适配器已写好且已接进 persistence，只是没人调——
// 回收策略注册（P1-12）、融合三步、定时载荷治愈、数字员工模板、demo 播种、runtime 注册表 boot、
// webhook 投递恢复在 PG daemon 上一步都没跑。这里不复述每一步的行为（各自有测试），只锁「两个入口
// 都调、且相对顺序一致」：任何一侧新增 / 挪动一步而另一侧没跟上，这里就红。

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { DAEMON_BOOT_STEPS } from '../src/cli/daemonLifecycleProgram'
import { bootImplementation, bootDeclaration, expectBootOrder } from './helpers/daemonProgramSource'

const cli = resolve(import.meta.dir, '..', 'src', 'cli')
const SQLITE_ENTRY = readFileSync(resolve(cli, 'start.ts'), 'utf8')
const POSTGRESQL_ENTRY = readFileSync(resolve(cli, 'postgresqlDaemonApplication.ts'), 'utf8')

test('both providers bind the common boot program to the original operations', () => {
  const bindings = {
    'process-registrations': 'registerTerminalWorkspacePrunePolicy(',
    'git-credential-lease-cleanup': 'cleanupOrphanedGitCredentialLeases(',
    'skill-identity-barrier': 'skillCatalogBoot.runIdentityMigrationBarrier()',
    'fusion-provenance': 'repairFusionProvenance(',
    'task-execution-recovery': 'runTaskExecutionBootRecovery({',
    'task-delete-recovery': 'recoverInterruptedTaskDeletes(',
    'archive-recovery': 'archive.recover({',
    'workspace-maintenance-recovery': 'Maintenance.recover({',
    'scheduled-payload-heal': 'healScheduledLaunchPayloads(',
    'fusion-decision-recovery': 'recoverFusionDecisions(',
    'fusion-resource-seed': 'seedFusionResources(',
    'employee-agent-templates': 'ensureDigitalEmployeeAgentTemplates(',
    'demo-seed': 'seedDemoContent({',
  } as const
  const sqlite = SQLITE_ENTRY.slice(
    SQLITE_ENTRY.indexOf('async function composeSqliteProviderSession('),
  )
  for (const source of [sqlite, POSTGRESQL_ENTRY]) {
    for (const [id, operation] of Object.entries(bindings))
      expect(bootImplementation(source, id as keyof typeof bindings)).toContain(operation)
  }
  expectBootOrder([
    'process-registrations',
    'git-credential-lease-cleanup',
    'skill-identity-barrier',
    'fusion-provenance',
    'employee-agent-templates',
    'scheduled-payload-heal',
    'fusion-resource-seed',
    'demo-seed',
    'task-execution-recovery',
    'task-delete-recovery',
    'archive-recovery',
    'workspace-maintenance-recovery',
    'fusion-decision-recovery',
  ])
})

test('delivery recovery directly follows MR terminal reconciliation inside execution recovery', () => {
  const mr = DAEMON_BOOT_STEPS.findIndex((step) => step.id === 'mr-terminal-reconcile')
  expect(DAEMON_BOOT_STEPS[mr + 1]).toMatchObject({
    id: 'webhook-delivery-recovery',
    phase: 'execution-recovery',
  })
  for (const source of [SQLITE_ENTRY, POSTGRESQL_ENTRY]) {
    expect(bootImplementation(source, 'mr-terminal-reconcile')).toContain(
      'await webhookTerminalControl.reconcileOnBoot()',
    )
    expect(bootImplementation(source, 'webhook-delivery-recovery')).toContain(
      'await recoverInterruptedDeliveries(',
    )
  }
})

test('fusion provenance stays fail-closed and precedes recovery and seeding', () => {
  expect(bootDeclaration('fusion-provenance').failure).toBe('fail-closed')
  const body = bootImplementation(POSTGRESQL_ENTRY, 'fusion-provenance')
  expect(body).not.toContain('try {')
  expect(body).not.toContain('catch')
  expectBootOrder(['fusion-provenance', 'fusion-resource-seed', 'fusion-decision-recovery'])
})

test('runtime 注册表 boot 每条 provider 路径恰好一次：SQLite 在 start.ts 主路径，PG 在 provider 会话建立时', () => {
  const marker = 'await initializeRuntimeRegistryBoot({'
  const sqliteEntryCalls = SQLITE_ENTRY.split(marker).length - 1
  // start.ts 里两处：composePostgresqlProviderSession（PG 路径）与 SQLite 主路径各一次。
  expect(sqliteEntryCalls).toBe(2)
  const providerSession = SQLITE_ENTRY.indexOf('async function composePostgresqlProviderSession(')
  const serve = SQLITE_ENTRY.indexOf('async function serveDaemon(')
  const first = SQLITE_ENTRY.indexOf(marker)
  expect(first).toBeGreaterThan(providerSession)
  expect(first).toBeLessThan(serve)
  // PG daemon 装配里不得再跑一次（否则内置 runtime 行会被重复播种 / 回填）。
  expect(POSTGRESQL_ENTRY).not.toContain(marker)
})
