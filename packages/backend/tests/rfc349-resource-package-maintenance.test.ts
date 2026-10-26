// RFC-345/W6 + RFC-349: Resource Package recovery is owned by Resource Catalog,
// keeps active applies live, and replays real provider-specific artifact tails.

import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import { createResourcePackageRecoveryScene } from '@/modules/resource-catalog/infrastructure/resourcePackageRecovery'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  createResourcePackageApplyActivityRegistry,
  type ResourcePackageApplyArtifactRecoveryPort,
  type ResourcePackageApplyJournalPort,
  type ResourcePackageApplyJournalSnapshot,
} from '../src/modules/resource-catalog/application/resourcePackageMaintenance'
import { postgresqlResourcePackageSkillRecoveryDisposition } from '../src/modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance'

const root = join(import.meta.dir, '..')

function journal(
  id: string,
  state: ResourcePackageApplyJournalSnapshot['state'],
  updatedAt: number,
): ResourcePackageApplyJournalSnapshot {
  return Object.freeze({
    id,
    state,
    preparedArtifactsJson: '[]',
    receiptJson: state === 'committed' ? JSON.stringify({ journalId: id, applied: [] }) : null,
    updatedAt,
  })
}

describe('RFC-349 provider-neutral Resource Package maintenance', () => {
  test('rolls committed tails and reaps only inactive stale attempts', async () => {
    const rows = [
      journal('committed', 'committed', 1),
      journal('stale', 'prepared', 1),
      journal('active', 'applying', 1),
      journal('recent', 'prepared', 9_500_000),
    ]
    const compensated: string[] = []
    const rolledForward: string[] = []
    const settled: string[] = []
    const port: ResourcePackageApplyJournalPort = {
      async list() {
        return rows
      },
      async compareAndSet(row, patch) {
        if (patch.state === 'failed') settled.push(row.id)
        return true
      },
    }
    const artifacts: ResourcePackageApplyArtifactRecoveryPort = {
      async rollForward(row) {
        rolledForward.push(row.id)
      },
      async compensate(row) {
        compensated.push(row.id)
      },
    }
    const command = createAtomicApplyRecovery([
      createResourcePackageRecoveryScene({
        journal: port,
        artifacts,
        now: () => 10_000_000,
      }),
    ])

    await expect(command.converge({ 'resource-package': ['active'] })).resolves.toEqual({
      failed: 1,
      rolledForward: 1,
    })
    expect(rolledForward).toEqual(['committed'])
    expect(compensated).toEqual(['stale'])
    expect(settled).toEqual(['stale'])
  })

  test('leaves an incompletely compensated attempt retryable', async () => {
    const settled: string[] = []
    const command = createAtomicApplyRecovery([
      createResourcePackageRecoveryScene({
        journal: {
          async list() {
            return [journal('retry', 'applying', 1)]
          },
          async compareAndSet(row, patch) {
            if (patch.state === 'failed') settled.push(row.id)
            return true
          },
        },
        artifacts: {
          async rollForward() {},
          async compensate() {
            throw new Error('filesystem still busy')
          },
        },
        now: () => 10_000_000,
      }),
    ])

    await expect(command.converge({ 'resource-package': [] })).resolves.toEqual({
      failed: 0,
      rolledForward: 0,
    })
    expect(settled).toEqual([])
  })

  test('pairs the PostgreSQL writer lease with one closed read-only query', () => {
    const registry = createResourcePackageApplyActivityRegistry()
    const lease = registry.tracker.enter('apply-1')
    expect(registry.query.activeApplyIds()).toEqual(['apply-1'])
    lease.leave()
    lease.leave()
    expect(registry.query.activeApplyIds()).toEqual([])
  })

  test('cleans historical PostgreSQL skill artifacts without reopening deleted or newer owners', () => {
    expect(
      postgresqlResourcePackageSkillRecoveryDisposition({
        currentContentVersion: null,
        artifactVersion: 2,
      }),
    ).toBe('cleanup-deleted')
    expect(
      postgresqlResourcePackageSkillRecoveryDisposition({
        currentContentVersion: 3,
        artifactVersion: 2,
      }),
    ).toBe('cleanup-superseded')
    expect(
      postgresqlResourcePackageSkillRecoveryDisposition({
        currentContentVersion: 1,
        artifactVersion: 2,
      }),
    ).toBe('reject-missing-generation')
    expect(
      postgresqlResourcePackageSkillRecoveryDisposition({
        currentContentVersion: 2,
        artifactVersion: 2,
      }),
    ).toBe('roll-forward-current')
  })

  test('supplies real SQLite and PostgreSQL journal plus artifact recovery factories', () => {
    const publicCommands = readFileSync(
      join(root, 'src/modules/resource-catalog/public/commands.ts'),
      'utf8',
    )
    const publicQueries = readFileSync(
      join(root, 'src/modules/resource-catalog/public/queries.ts'),
      'utf8',
    )
    const composition = readFileSync(
      join(root, 'src/modules/resource-catalog/composition/resourcePackageMaintenance.ts'),
      'utf8',
    )
    const journalSource = readFileSync(
      join(root, 'src/modules/resource-catalog/infrastructure/resourcePackageApplyJournal.ts'),
      'utf8',
    )
    const sqlite = readFileSync(
      join(root, 'src/modules/resource-catalog/infrastructure/resourcePackageOperationRecovery.ts'),
      'utf8',
    )
    const postgresql = readFileSync(
      join(
        root,
        'src/modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance.ts',
      ),
      'utf8',
    )
    const nativeRecovery = readFileSync(
      join(
        root,
        'src/modules/resource-catalog/infrastructure/local/fileResourcePackageRecoveryEffects.ts',
      ),
      'utf8',
    )

    expect(publicCommands).not.toContain('export interface ResourcePackageApplyMaintenanceCommand')
    expect(publicQueries).toContain('export interface ResourcePackageApplyActivityQuery')
    expect(publicCommands).not.toContain('DbClient')
    expect(publicQueries).not.toContain('DbClient')
    expect(
      composition.match(/export function composeResourcePackageApplyMaintenance\(/g),
    ).toHaveLength(1)
    expect(composition).toContain('scene: createResourcePackageRecoveryScene(recovery)')
    expect(composition).toContain('activityTracker: activity.tracker')
    expect(composition.match(/journal: createResourcePackageApplyJournalPort\(/g)).toHaveLength(1)
    expect(journalSource).toContain('createResourcePackageAtomicJournal(db)')
    expect(
      readFileSync(
        join(root, 'src/modules/resource-catalog/infrastructure/resourcePackageAtomicJournal.ts'),
        'utf8',
      ),
    ).toContain('.from(table)')
    expect(sqlite).toContain('await effects.swapStaged(filesDir, staged.publishId)')
    expect(postgresql).toContain(
      'await effects.restoreBackup(liveDirectory, input.artifact.operationId)',
    )
    expect(postgresql).toContain("disposition === 'cleanup-superseded'")
    expect(postgresql).toContain('await effects.hashRegularTree(liveDirectory)')
    expect(nativeRecovery).toContain('return swapInStaged(liveReference, publicationId)')
    expect(nativeRecovery).toContain('return restoreFromBackup(liveReference, publicationId)')
    expect(nativeRecovery).toContain('return hashRegularFileTree(reference)')
    expect(postgresql).not.toMatch(/from ['"][^'"]*resourcePackageOperationRecovery['"]/)
    expect(composition).toContain('createVersionedResourcePackageArtifactRecovery(')
  })
})
