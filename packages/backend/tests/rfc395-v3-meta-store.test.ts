// RFC-395 V3-R: authored for T18; offline target receipts never activate runtime wiring.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { describeV3Providers, type V3Harness } from './helpers/rfc395V3Harness'
import { seedRequiredRows } from './helpers/rfc395V2/integrationFixtures'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { planConversion } from '@/platform/persistence/migration/conversion/plan'
import { valueDigest, bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { encodeStagedValue } from '@/platform/persistence/migration/conversion/staging'
import type { UnitOutput } from '@/platform/persistence/migration/conversion/types'
import {
  type MigrationRunInit,
  VALIDATION_CHECKS,
} from '@/platform/persistence/migration/run/types'
import { installConversionTarget } from '@/platform/persistence/migration/target/install'
import { createTargetLoader } from '@/platform/persistence/migration/target/loader'
import {
  createMigrationMetaStore,
  collectMigrationRows,
} from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { createTargetConversionSink } from '@/modules/system-operations/infrastructure/epochSwitch/conversionSink'
import { createTaskRestrictionQuery } from '@/modules/system-operations/infrastructure/epochSwitch/historyRestrictions'
import { createMigrationApproval } from '@/modules/system-operations/domain/epochSwitch/documents'

// Slowest case took 5.21 s on CI run 40433510287 including hooks; allow 20 s.
setDefaultTimeout(20_000)

function sealUnit(output: UnitOutput): UnitOutput {
  const { digest: _digest, ...receipt } = output.receipt
  const { receipt: _receipt, ...payload } = output
  return {
    ...payload,
    receipt: { ...receipt, digest: valueDigest({ receipt, output: encodeStagedValue(payload) }) },
  }
}
function unit(id = 'unit-a', key = 'a'): UnitOutput {
  const encoded = encodeMigrationKey('maintenance_state', [canonicalValue(key)])
  const counts = { converted: 1, preserved: 0, archived: 0, blocked: 0 }
  return sealUnit({
    receipt: {
      version: 1,
      unitId: id,
      unit: {
        kind: 'source-chunk',
        table: 'maintenance_state',
        phase: 'current',
        afterKey: null,
        limit: 1,
      },
      sourceVersion: 'fixture',
      rule: { id: 'fixture/copy', version: 1 },
      lookups: [],
      sources: [
        {
          table: 'maintenance_state',
          phase: 'current',
          rows: 1,
          digest: valueDigest(key),
          keyDigest: valueDigest(encoded),
          firstKey: encoded,
          lastKey: encoded,
          counts,
          exceptions: 0,
          historyOnly: 0,
        },
      ],
      targets: [{ table: 'maintenance_state', rows: 1, digest: valueDigest(key) }],
      counts: { ...counts, exceptions: 0, historyOnly: 0 },
      digest: '',
    },
    rows: [{ table: 'maintenance_state', rows: [{ key, value: 'value', updated_at: 123 }] }],
    dispositions: [],
    artifacts: [],
    archives: [],
    records: [],
    blocks: [],
  })
}
async function fixture(h: V3Harness) {
  await h.source.install()
  await seedRequiredRows(h.source)
  const input = await h.input({ contentManifestDigest: valueDigest('content') })
  const plan = planConversion(input)
  await installConversionTarget(h.target, {
    head: h.head,
    metaTables: h.metaTables,
    generationId: h.generationId,
    now: 123,
  })
  const meta = createMigrationMetaStore({ target: h.target, registry: persistenceSchema })
  const row: MigrationRunInit = {
    version: 1,
    runId: 'run-r',
    operationId: h.operationId,
    ordinal: 1,
    kind: 'epoch-conversion',
    role: 'converted',
    sourceProvider: h.sourceProvider,
    sourceEpoch: 1,
    sourceKind: input.preflight.kind,
    targetProvider: h.targetProvider,
    targetEpoch: 2,
    migrationPlanDigest: valueDigest('plan'),
    approvalDigest: valueDigest('approval'),
    conversionPlan: plan,
    emptyTables: [],
    startedAt: 123,
  }
  const binding = {
    planDigest: plan.digest,
    sourceWatermark: plan.sourceWatermark,
    sourceVersion: plan.sourceVersion,
    sourceGenerationId: plan.sourceGenerationId,
    targetGeneration: plan.targetGeneration,
    converterVersion: plan.converterVersion,
    ruleSetDigest: plan.ruleSetDigest,
    preUpgradeWatermark: plan.preUpgradeWatermark,
    stagingDigest: valueDigest('stage'),
    lookupDigest: valueDigest('lookup'),
  }
  const loader = createTargetLoader({
    registry: persistenceSchema,
    provider: h.targetProvider,
  })
  const sink = createTargetConversionSink({
    target: h.target,
    loader,
    meta,
    run: row,
    now: () => 123,
  })
  const summary = {
    status: 'converted' as const,
    tableReceipts: [],
    blocks: [],
    records: [],
    historyOnly: [],
    stagingDigest: binding.stagingDigest,
    plan,
  }
  return { input, plan, meta, row, binding, loader, sink, summary }
}

describeV3Providers('RFC-395 V3 meta access', (h) => {
  test('approval history binds the operation and run, validates its chain and replays exactly', async () => {
    const f = await fixture(h)
    await f.sink.open(f.binding)
    const first = createMigrationApproval({
      version: 1,
      operationId: h.operationId,
      runId: f.row.runId,
      sequence: 0,
      planDigest: f.row.migrationPlanDigest,
      approvalDigest: f.row.approvalDigest,
      approvedAt: 123,
      previousApprovalDigest: null,
    })
    const write = (approval: typeof first) =>
      h.target.transaction((tx) => f.meta.withConnection(tx).recordApproval(approval))
    await write(first)
    await write(first)
    const second = createMigrationApproval({
      ...first.payload,
      sequence: 1,
      planDigest: valueDigest('actual-plan'),
      approvalDigest: valueDigest('changed-material'),
      approvedAt: 456,
      previousApprovalDigest: first.digest,
    })
    for (const payload of [
      { ...second.payload, sequence: 2 },
      { ...second.payload, previousApprovalDigest: null },
      { ...second.payload, operationId: 'dbm_e2_other_operation' },
      { ...first.payload, runId: 'other-run' },
      { ...first.payload, approvalDigest: valueDigest('conflict') },
    ])
      await expect(write(createMigrationApproval(payload))).rejects.toThrow()
    await write(second)
    await write(first)
    expect(await f.meta.approvals(f.row.runId)).toEqual([first, second])
    expect(await f.meta.select('migration_approvals', { runId: f.row.runId })).toHaveLength(2)
    expect(await f.meta.migrationRun(f.row.runId)).toMatchObject({
      approvalDigest: f.row.approvalDigest,
      migrationPlanDigest: f.row.migrationPlanDigest,
    })
  })
  test('revalidation replaces only validation blocks atomically and freezes after export', async () => {
    const f = await fixture(h)
    await f.sink.open(f.binding)
    await f.sink.finish(f.summary)
    const block = {
      code: 'v3-validation-probes',
      scope: 'global' as const,
      sourceTable: null,
      sourceKey: null,
      taskId: null,
      runId: null,
      missingFields: [],
      detail: null,
    }
    await h.target.transaction((tx) =>
      f.meta
        .withConnection(tx)
        .writeBlocks(f.row.runId, 'load', 'other-unit', [
          { ...block, code: 'retained-load-block' },
        ]),
    )
    const report = (failed: boolean, at: number) => {
      const payload = {
        version: 1 as const,
        runId: f.row.runId,
        validatedAt: at,
        passed: !failed,
        checks: VALIDATION_CHECKS.map((check) => ({
          check,
          passed: !failed || check !== 'probes',
          detail: null,
        })),
        blocks: failed ? [block] : [],
        contentDrift: [],
        historyRestrictionsDigest: valueDigest([]),
        probes: [],
      }
      return { ...payload, digest: valueDigest(payload) }
    }
    const save = (failed: boolean, at: number) =>
      h.target.transaction((tx) => f.meta.withConnection(tx).saveValidation(report(failed, at)))
    await save(true, 123)
    expect(
      (await f.meta.blocks({ runId: f.row.runId })).filter((row) => row.origin === 'validation'),
    ).toHaveLength(1)
    await expect(
      h.target.transaction(async (tx) => {
        await f.meta.withConnection(tx).saveValidation(report(false, 234))
        throw new Error('rollback-validation')
      }),
    ).rejects.toThrow('rollback-validation')
    expect((await f.meta.migrationRun(f.row.runId))!.validation!.passed).toBe(false)
    expect(
      (await f.meta.blocks({ runId: f.row.runId })).filter((row) => row.origin === 'validation'),
    ).toHaveLength(1)
    await save(false, 345)
    expect((await f.meta.blocks({ runId: f.row.runId })).map((row) => row.block.code)).toEqual([
      'retained-load-block',
    ])
    await h.target.transaction((tx) =>
      f.meta.withConnection(tx).saveExport(f.row.runId, {
        bytes: Buffer.from('export'),
        digest: valueDigest('export'),
        path: null,
      }),
    )
    await expect(save(true, 456)).rejects.toThrow('v3-validation-frozen')
  })
  test('unit evidence, exceptions and task restrictions round-trip by primary keys', async () => {
    const f = await fixture(h)
    await f.sink.open(f.binding)
    const base = unit()
    const sourceKey = base.receipt.sources[0]!.firstKey!
    const archiveBytes = Buffer.from('full source evidence')
    const archiveRef = `archive:sha256:${bytesDigest(archiveBytes).slice(7)}` as const
    const output = sealUnit({
      ...base,
      dispositions: [
        {
          sourceTable: 'maintenance_state',
          sourceKey,
          sourcePhase: 'current',
          class: 'preserved',
          kind: 'history-only',
          targets: [],
          archive: null,
          rule: base.receipt.rule,
          history: {
            taskId: 'task',
            runId: 'node-run',
            execution: 'retryable-history',
            missingFields: ['checkpoint'],
          },
          decision: { code: 'history-fixture', detail: {} },
        },
      ],
      artifacts: [
        {
          sourceTable: 'maintenance_state',
          sourceKey,
          sourceColumn: 'value',
          originalReference: 'file',
          target: {
            table: 'maintenance_state',
            key: sourceKey,
            contentId: null,
            backend: 'local-file',
          },
          bytes: { sha256: valueDigest('file'), size: 7 },
          publication: 'not-required',
          missing: null,
        },
      ],
      archives: [
        {
          ref: archiveRef,
          kind: 'source-journal',
          sourceTable: 'maintenance_state',
          format: 'raw-chunk@1',
          bytes: archiveBytes,
          rows: 1,
        },
      ],
      records: [{ kind: 'source-generation', generationId: 'old', evidence: { pointer: 'v1' } }],
    })
    await f.sink.commitUnit(output)
    expect(
      await collectMigrationRows(
        f.meta.dispositions({
          runId: f.row.runId,
          source: { sourceTable: 'maintenance_state', sourceKey, sourcePhase: 'current' },
        }),
      ),
    ).toEqual([...output.dispositions])
    expect(
      await collectMigrationRows(
        f.meta.artifacts({ runId: f.row.runId, unitId: base.receipt.unitId }),
      ),
    ).toEqual([...output.artifacts])
    expect(await collectMigrationRows(f.meta.records(f.row.runId))).toEqual([...output.records])
    expect(
      Buffer.from((await f.meta.archive({ runId: f.row.runId, ref: archiveRef }))!.bytes),
    ).toEqual(archiveBytes)
    const restrictions = await createTaskRestrictionQuery(f.meta)({
      operationId: h.operationId,
      taskId: 'task',
    })
    expect(restrictions.restrictions).toHaveLength(1)
    expect(restrictions.restrictions[0]).toMatchObject({
      runId: f.row.runId,
      unitId: base.receipt.unitId,
      history: { runId: 'node-run' },
    })
    expect(
      (await createTaskRestrictionQuery(f.meta)({ operationId: 'different', taskId: 'task' }))
        .restrictions,
    ).toEqual([])
    expect(
      await f.meta.unitSources({
        runId: f.row.runId,
        sourceTable: 'maintenance_state',
        sourcePhase: 'pre-upgrade',
      }),
    ).toEqual([])
    expect(
      await f.meta.unitSources({
        runId: f.row.runId,
        sourceTable: 'maintenance_state',
        sourcePhase: 'current',
      }),
    ).toHaveLength(1)
  })
  test('PK duplicate writes fail and meta enum/null values are checked before SQL', async () => {
    const f = await fixture(h)
    await f.sink.open(f.binding)
    await f.sink.commitUnit(unit())
    await expect(
      h.target.transaction((tx) =>
        f.meta.withConnection(tx).writeUnit(f.row.runId, unit(), 'committed', 123),
      ),
    ).rejects.toThrow()
    await expect(
      f.meta.update('migration_runs', { runId: f.row.runId }, { state: 'invented' }),
    ).rejects.toThrow('v3-meta-enum')
    expect(await collectMigrationRows(f.meta.units(f.row.runId))).toHaveLength(1)
  })
})
