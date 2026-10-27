// RFC-395 T19: budget measured staging and all run-only copies, including remote targets.
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { estimateEpochCapacity } from '@/modules/system-operations/domain/epochSwitch/capacity'
import { createEpochSwitchApplication } from '@/modules/system-operations/application/epochSwitch/application'
import { createMigrationPlanDocument } from '@/modules/system-operations/domain/epochSwitch/documents'
import { measureMigrationCapacity } from '@/platform/persistence/migration/freeze/capacity'
import { fixtureDigest, makeSwitchFixture } from './helpers/rfc395V3SwitchFixture'
import { describeV2Providers } from './helpers/rfc395V2Harness'

for (const upgradeBytes of [0, 250])
  for (const targetOnOperationFilesystem of [true, false])
    test(`T19 estimate: offline upgrade ${upgradeBytes > 0}, local target ${targetOnOperationFilesystem}`, () => {
      const actual = estimateEpochCapacity({
        sourceBytes: 100,
        operationBytes: 25 + upgradeBytes,
        stagingPeakBytes: 2000,
        availableBytes: 800,
        targetOnOperationFilesystem,
        localArtifactMirrors: true,
      })
      expect(actual).toEqual({
        sourceBytes: 100,
        targetBytes: 150,
        backupBytes: 400,
        stagingBytes: 2000,
        requiredBytes: 2425 + upgradeBytes + (targetOnOperationFilesystem ? 150 : 0),
        availableBytes: 800,
        components: {
          operationBytes: 25 + upgradeBytes,
          runBackupBytes: 100,
          switchBackupBytes: 100,
          artifactMirrorBytes: 200,
          targetFilesystemBytes: targetOnOperationFilesystem ? 150 : 0,
        },
      })
    })

test('T19 does not invent unmeasured staging or source bytes, or budget absent mirrors', () => {
  const input = {
    sourceBytes: 100,
    operationBytes: 25,
    stagingPeakBytes: 2000,
    availableBytes: 800,
    targetOnOperationFilesystem: true,
    localArtifactMirrors: false,
  }
  expect(estimateEpochCapacity(input).backupBytes).toBe(200)
  expect(estimateEpochCapacity({ ...input, stagingPeakBytes: null }).requiredBytes).toBeNull()
  expect(estimateEpochCapacity({ ...input, sourceBytes: null }).requiredBytes).toBeNull()
})

test('T19 planner blocks the measured peak even when the old 4x check would pass', async () => {
  const f = makeSwitchFixture()
  const dryRun = f.deps.conversion.dryRun
  let measuredAfterDryRun = false
  let finished = false
  f.deps.conversion.dryRun = async (request) => {
    const result = await dryRun(request)
    finished = true
    return { ...result, stagingPeakBytes: 2000 }
  }
  f.deps.measureCapacity = async () => {
    measuredAfterDryRun = finished
    return { sourceBytes: 100, operationBytes: 250, availableBytes: 800 }
  }
  try {
    const plan = await f.app.plan({})
    expect(measuredAfterDryRun).toBe(true)
    expect(plan.plan.payload.estimates.requiredBytes).toBe(2800)
    expect(plan.plan.payload.blocks.map((entry) => entry.block)).toContainEqual(
      expect.objectContaining({
        code: 'v3-capacity',
        detail: { requiredBytes: 2800, availableBytes: 800 },
      }),
    )
    await expect(
      f.app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest }),
    ).rejects.toThrow('plan-blocked')
    expect(f.control.quiesceCalls).toBe(0)
  } finally {
    f.close()
  }
})

test('T19 restored backup capacity uses its rematerialized path after scratch replacement', async () => {
  const f = makeSwitchFixture()
  try {
    const current = join(f.root, 'materialized-backup')
    mkdirSync(current)
    writeFileSync(join(current, 'db.sqlite'), Buffer.alloc(789))
    f.deps.unpackBackup = async () => ({
      sourceKind: 'hosted-backup',
      root: join(f.root, 'previous-scratch'),
      digest: fixtureDigest,
    })
    f.deps.materializeBackup = async () => ({ root: current })
    f.deps.measureCapacity = async (source, operationRoot) => {
      expect(source).toMatchObject({ kind: 'backup', root: current })
      return measureMigrationCapacity(source, operationRoot)
    }
    const plan = await f.app.restoreBackup({ artifact: 'retained-backup' })
    expect(plan.plan.payload.estimates.sourceBytes).toBe(789)
  } finally {
    f.close()
  }
})

test('T19 numeric capacity and manifest path changes leave material approval unchanged', async () => {
  const f = makeSwitchFixture()
  try {
    const first = (await f.app.plan({})).plan
    const changed = createMigrationPlanDocument({
      ...first.payload,
      contentManifestPath: 'runs/later/plan-content/2.json',
      estimates: {
        ...first.payload.estimates,
        ...estimateEpochCapacity({
          sourceBytes: 999,
          operationBytes: 15000,
          stagingPeakBytes: 20000,
          availableBytes: 100000,
          targetOnOperationFilesystem: true,
          localArtifactMirrors: true,
        }),
      },
    })
    expect(changed.digest).not.toBe(first.digest)
    expect(changed.approvalDigest).toBe(first.approvalDigest)
    const app = createEpochSwitchApplication({ ...f.deps })
    expect(
      (await app.run({ operationId: f.operationId, approve: changed.approvalDigest })).phase,
    ).toBe('activated')
  } finally {
    f.close()
  }
})

describeV2Providers('T19 source and operation measurements', (h) => {
  test('measures the native source and retained files independently of target storage', async () => {
    await h.install()
    const root = join(h.sourceHarness.operationRoot, 't19-capacity')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'retained'), Buffer.alloc(789))
    const source =
      h.sourceHarness.provider === 'sqlite'
        ? {
            kind: 'sqlite-file' as const,
            path: h.sourceHarness.sqlitePath,
            pointerPath: join(root, 'pointer'),
          }
        : { kind: 'postgresql-database' as const, profileRef: 'env:T19_SOURCE' }
    const measured = await measureMigrationCapacity(source, root, async () => {
      const rows = await h.sourceHarness.runtime
        .providerPool('migration')
        .unsafe('SELECT pg_database_size(current_database()) AS bytes')
      return Number(rows[0]!.bytes)
    })
    expect(measured.sourceBytes).toBeGreaterThan(0)
    expect(measured.operationBytes).toBe(789)
    expect(measured.availableBytes).toBeGreaterThan(0)
    const local = estimateEpochCapacity({
      ...measured,
      operationBytes: measured.operationBytes!,
      stagingPeakBytes: 999,
      targetOnOperationFilesystem: true,
      localArtifactMirrors: true,
    })
    const remote = estimateEpochCapacity({
      ...measured,
      operationBytes: measured.operationBytes!,
      stagingPeakBytes: 999,
      targetOnOperationFilesystem: false,
      localArtifactMirrors: true,
    })
    expect(local.requiredBytes! - remote.requiredBytes!).toBe(local.targetBytes!)
    expect(remote.components!.targetFilesystemBytes).toBe(0)
  })
})
