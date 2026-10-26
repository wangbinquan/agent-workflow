// RFC-359 W3-T15 —— 两个 daemon 入口的 boot 步骤必须同序、同一份实现。
//
// dual-provider-parity-audit-2026-09-04 T15：多数 PG 适配器已写好且已接进 persistence，只是没人调——
// 回收策略注册（P1-12）、融合三步、定时载荷治愈、数字员工模板、demo 播种、runtime 注册表 boot、
// webhook 投递恢复在 PG daemon 上一步都没跑。这里不复述每一步的行为（各自有测试），只锁「两个入口
// 都调、且相对顺序一致」：任何一侧新增 / 挪动一步而另一侧没跟上，这里就红。

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { DAEMON_BOOT_STEPS } from '../src/bootstrap/daemonLifecycleProgram'
import { bootImplementation, expectBootOrder } from './helpers/daemonProgramSource'

const APPLICATION = readFileSync(
  resolve(import.meta.dir, '../src/bootstrap/daemonApplication.ts'),
  'utf8',
)

test('both providers bind the common boot program to the original operations', () => {
  const bindings = {
    'process-registrations': 'registerTerminalWorkspacePrunePolicy(',
    'git-credential-lease-cleanup': 'cleanupOrphanedGitCredentialLeases(',
    'skill-operation-recovery': 'skillCatalogBoot.recoverOperations()',
    'task-execution-recovery': 'runTaskExecutionBootRecovery({',
    'task-delete-recovery': 'recoverInterruptedTaskDeletes(',
    'archive-recovery': 'archive.recover({',
    'workspace-maintenance-recovery': 'Maintenance.recover({',
    'fusion-decision-recovery': 'recoverFusionDecisions(',
    'fusion-resource-seed': 'seedFusionResources(',
    'employee-agent-templates': 'ensureDigitalEmployeeAgentTemplates(',
    'demo-seed': 'seedDemoContent({',
  } as const
  for (const [id, operation] of Object.entries(bindings))
    expect(bootImplementation(APPLICATION, id as keyof typeof bindings)).toContain(operation)
  expectBootOrder([
    'process-registrations',
    'git-credential-lease-cleanup',
    'skill-operation-recovery',
    'employee-agent-templates',
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
  for (const source of [APPLICATION]) {
    expect(bootImplementation(source, 'mr-terminal-reconcile')).toContain(
      'await webhookTerminalControl.reconcileOnBoot()',
    )
    expect(bootImplementation(source, 'webhook-delivery-recovery')).toContain(
      'await recoverInterruptedDeliveries(',
    )
  }
})

test('fusion upgrade is converter-only, with explicit rule coverage', () => {
  expect(APPLICATION).not.toContain('repairFusionProvenance')
  const assembly = readFileSync(
    resolve(import.meta.dir, '../src/bootstrap/conversionRules.ts'),
    'utf8',
  )
  expect(assembly).toContain('fusionBoot,')
  expect(assembly).toContain('memoryBoot,')
  const cases = readFileSync(
    resolve(import.meta.dir, 'rfc395-boot-fusion-conversion.test.ts'),
    'utf8',
  )
  expect(cases).toContain('bootUpgradeEffectsFromRecords')
  expect(cases).toContain('v2-boot-fusion-source-unproven')
  expect(cases).toContain('wouldPreviouslyQuarantine: null')
  expect(cases).toContain('wouldPreviouslyTerminalize: null')
})

test('one application graph initializes the runtime registry once for both adapters', () => {
  expect(APPLICATION.split('await initializeRuntimeRegistryBoot({').length - 1).toBe(1)
  expect(bootImplementation(APPLICATION, 'runtime-registry')).toContain(
    'operations: core.runtimeRegistry',
  )
  const session = readFileSync(
    resolve(import.meta.dir, '../src/bootstrap/daemonSession.ts'),
    'utf8',
  )
  expect(session).not.toContain('initializeRuntimeRegistryBoot(')
  expect(session).toContain('...application.lifecycleSteps')
})
