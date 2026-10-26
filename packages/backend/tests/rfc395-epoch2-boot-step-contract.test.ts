import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DAEMON_BOOT_STEPS } from '@/bootstrap/daemonLifecycleProgram'
import { conversionContributions, conversionReadOnlyProbes } from '@/bootstrap/conversionRules'
import { bootImplementation } from './helpers/daemonProgramSource'
const source = (path: string) => readFileSync(resolve(import.meta.dir, '../src', path), 'utf8')
const expected = [
  'runtime-declarations',
  'process-registrations',
  'transport-projections',
  'git-credential-lease-cleanup',
  'daemon-identity',
  'skill-operation-recovery',
  'skill-availability-gate',
  'skill-live-files',
  'runtime-registry',
  'event-catalog',
  'employee-agent-templates',
  'employee-tool-catalog',
  'employee-authoring-ready',
  'fusion-resource-seed',
  'demo-seed',
  'task-execution-recovery',
  'observation-interrupt',
  'task-delete-recovery',
  'archive-recovery',
  'workspace-maintenance-recovery',
  'fusion-decision-recovery',
  'mr-terminal-reconcile',
  'webhook-delivery-recovery',
  'employee-upgrade-settlement',
  'maintenance-boot-snapshot',
  'hosted-targeted-resume',
  'resource-reverify',
  'bootstrap-admin-hint',
]
test('epoch-2 has the exact 28 steps and preserves recovery ordering', () => {
  expect<string[]>(DAEMON_BOOT_STEPS.map((step) => step.id)).toEqual(expected)
  expect(expected).toHaveLength(28)
  expect(expected.indexOf('skill-operation-recovery')).toBeLessThan(
    expected.indexOf('skill-availability-gate'),
  )
  const application = source('bootstrap/daemonApplication.ts')
  expect(bootImplementation(application, 'skill-operation-recovery')).toContain(
    'skillCatalogBoot.recoverOperations()',
  )
  expect(bootImplementation(application, 'resource-reverify')).toContain('reverifySnapshots')
  expect(bootImplementation(application, 'resource-reverify')).not.toContain(
    'backfillLegacyVersions',
  )
  for (const retired of [
    'runIdentityMigrationBarrier',
    'ensureCredentialsSealed',
    'repairFusionProvenance',
    'healScheduledLaunchPayloads',
    'recoverWhileDraining',
  ])
    expect(application).not.toContain(retired)
  expect(source('modules/task-execution/application/bootExecutionRecovery.ts')).not.toMatch(
    /backfill/i,
  )
  const runtime = source('modules/runtime-management/application/runtimeRegistryBoot.ts')
  expect(runtime).toContain('seedBuiltinRuntimes')
  expect(runtime).not.toMatch(/migrateConfigIntoBuiltins|assertConfigDefaultsMigrated/)
})
test('every retired upgrade has an explicit registered owner and all probes are unique', () => {
  const refs = conversionContributions
    .flatMap((contribution) => contribution.rules ?? [])
    .map((rule) => rule.ref.id)
  for (const id of [
    'source-control/boot-repository-urls',
    'resource-catalog/boot-skills',
    'knowledge-evolution/boot-fusion-provenance',
    'memory/boot-fused-provenance',
    'integration/boot-scheduled-payload',
    'runtime-management/boot-runtime-config',
    'history/writer-drain',
    'task-execution/run/epoch1',
  ])
    expect(refs).toContain(id)
  expect(conversionReadOnlyProbes.map((probe) => probe.id)).toEqual([
    'task-execution:task-aggregate',
    'task-execution:run-selection-integrity',
    'task-execution:run-input-integrity',
    'collaboration:target-clarify-and-gate-content',
    'resource-catalog:apply-artifact-envelopes',
    'resource-catalog:agent-reference-order',
    'resource-catalog:workflow-index-parity',
    'intent:apply-artifact-envelopes',
    'platform/content:catalog-bytes-and-publications',
    'platform/content:skill-reference-columns',
    'code-capability:history-index',
  ])
})
