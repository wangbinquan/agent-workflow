import type { SchemaContribution } from '@/platform/persistence/schema/contribution'
// RFC-395 V3-R: authored for T18; offline target receipts never activate runtime wiring.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { describeV3Providers, type V3Harness } from './helpers/rfc395V3Harness'
import { seedRequiredRows } from './helpers/rfc395V2/integrationFixtures'
import { seedFrozenPostgresqlSource } from './helpers/rfc395V3/sourceSeeds'
import { frozenValues, readFrozenRows } from './helpers/rfc395V2/contentFixtures'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { planConversion } from '@/platform/persistence/migration/conversion/plan'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type {
  MigrationRunInit,
  TargetFinalizeReport,
  ValidationCheck,
  VerifiableContentInventory,
} from '@/platform/persistence/migration/run/types'
import { installConversionTarget } from '@/platform/persistence/migration/target/install'
import { createTargetLoader, targetTableName } from '@/platform/persistence/migration/target/loader'
import {
  createMigrationMetaStore,
  collectMigrationRows,
} from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { createTargetConversionSink } from '@/modules/system-operations/infrastructure/epochSwitch/conversionSink'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import {
  createTargetGenerationHandle,
  createTargetGenerationPort,
} from '@/modules/system-operations/infrastructure/epochSwitch/targetGeneration'
import {
  createActivationReceipt,
  createMigrationApproval,
  createRollbackReceipt,
  createSwitchReceipt,
} from '@/modules/system-operations/domain/epochSwitch/documents'
import {
  canonicalOperatorDecisions,
  type EpochSwitchFaultPoint,
} from '@/modules/system-operations/domain/epochSwitch/model'
import {
  operatorDecisionRowDigest,
  type OperatorDecision,
  type TargetRow,
} from '@/platform/persistence/migration/conversion/types'
import { openConversionTarget } from '@/platform/persistence/migration/target/connection'
import { markFirstLiveWrite } from '@/platform/persistence/schema/history/markers'
import { validateConversionRun } from '@/modules/system-operations/infrastructure/epochSwitch/validation'

// Native loading, catalog validation and integrity checks take about 11 s per CI-scaled case; allow 35 s.
setDefaultTimeout(35000)

async function fixture(h: V3Harness, acknowledged = false) {
  await h.source.install()
  await seedRequiredRows(h.source)
  let operatorDecisions: OperatorDecision[] = []
  if (acknowledged) {
    await h.source.write(
      'code_work_items',
      ['a', 'b', 'c'].map((id) =>
        frozenValues('code_work_items', { id, anchor_id: `anchor-${id}`, status: 'queued' }),
      ),
    )
    operatorDecisions = (await readFrozenRows(h.source, 'code_work_items')).map((row) => ({
      kind: 'acknowledge-unfinished-legacy-work',
      sourceTable: row.table,
      sourceKey: row.encodedKey,
      sourcePhase: row.phase,
      rowDigest: operatorDecisionRowDigest(row),
      blockCode: 'v2-code-history-unfinished',
      acknowledgedBy: 'operator',
      acknowledgedAt: 123,
      reason: 'Retain retired writer history.',
    }))
    operatorDecisions.sort((a, b) => valueDigest(b).localeCompare(valueDigest(a)))
  }
  const input = await h.input({ contentManifestDigest: valueDigest('content'), operatorDecisions })
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

describeV3Providers('RFC-395 V3 activation validation', (h) => {
  test('frozen source installations contain family seeds and preserve existing routing values', async () => {
    const version = await h.source.install()
    const source = h.source.sourceHarness
    const table = source.table('committed_event_family_cutovers')
    const rows = await source.native.execute(`SELECT producer, family FROM ${table}`)
    expect(rows.map((row) => `${row.producer}/${row.family}`).sort()).toEqual(
      persistenceSchema.contributions
        .flatMap((contribution: SchemaContribution) => contribution.seeds ?? [])
        .filter((seed) => seed.table === 'committed_event_family_cutovers')
        .flatMap((seed) => seed.rows.map((row) => `${row.producer}/${row.family}`))
        .sort(),
    )
    expect(
      await source.native.execute(
        `SELECT mode FROM ${source.table('employee_os_writer_state')} WHERE id='global'`,
      ),
    ).toEqual([{ mode: 'pre-cutover' }])
    await source.native.execute(`UPDATE ${table} SET epoch=77, change_ref='retained-source-route'`)
    if (h.sourceProvider === 'postgresql') await seedFrozenPostgresqlSource(h.source, version)
    const retained = await source.native.execute(`SELECT epoch, change_ref FROM ${table}`)
    expect(retained).toHaveLength(rows.length)
    expect(
      retained.every(
        (row) => Number(row.epoch) === 77 && row.change_ref === 'retained-source-route',
      ),
    ).toBe(true)
  })
  test('latest approval and three shuffled acknowledgements activate through the native handle', async () => {
    const f = await fixture(h, true)
    await runConversion(f.input, f.sink)
    const handle = createTargetGenerationHandle({
      target: h.target,
      generationId: h.generationId,
      registry: persistenceSchema,
      head: h.head,
      catalogCache: h.catalogCache,
      now: () => 123,
    })
    const inventory: VerifiableContentInventory = {
      ...f.input.content,
      async verifyUnchanged(receipts) {
        for await (const receipt of receipts) expect(receipt.sourceTable).toBeTruthy()
        return []
      },
    }
    const result = await handle.validate({
      runId: f.row.runId,
      preflight: f.input.preflight,
      preUpgrade: null,
      inventory,
      probes: [
        {
          id: 'catalog-read',
          async run(connection) {
            const rows = await connection.query(
              `SELECT COUNT(*) AS n FROM ${targetTableName(h.targetProvider, 'users')}`,
            )
            return { id: 'catalog-read', passed: Number(rows[0]!.n) > 0, detail: null }
          },
        },
      ],
    })
    expect(result.checks.filter((check) => !check.passed)).toEqual([])
    expect(result.passed).toBe(true)
    expect(result.checks.every((check) => check.passed)).toBe(true)
    expect((await f.meta.migrationRun(f.row.runId))?.state).toBe('validated')
    expect(await handle.firstLiveWriteAt()).toBeNull()
    const exported = await handle.exportReceipts({
      runId: f.row.runId,
      operationRoot: h.operationRoot,
    })
    await h.target.transaction((tx) =>
      f.meta.withConnection(tx).insert('generations', {
        generationId: h.generationId,
        schemaEpoch: 2,
        role: 'converted',
        state: 'prepared',
        provider: h.targetProvider,
        operationId: h.operationId,
        runId: f.row.runId,
        sourceGenerationId: f.plan.sourceGenerationId,
        contractDigest: h.head.contract.contract.digest,
        planDigest: h.head[h.targetProvider].digest,
        activationReceiptDigest: null,
        createdAt: 123,
        activatedAt: null,
        retiredAt: null,
      }),
    )
    const run = (await f.meta.migrationRun(f.row.runId))!
    const firstApproval = createMigrationApproval({
      version: 1,
      operationId: h.operationId,
      runId: f.row.runId,
      sequence: 0,
      planDigest: f.row.migrationPlanDigest,
      approvalDigest: f.row.approvalDigest,
      approvedAt: 123,
      previousApprovalDigest: null,
    })
    const latestApproval = createMigrationApproval({
      ...firstApproval.payload,
      sequence: 1,
      planDigest: valueDigest('validated-material-plan'),
      approvalDigest: valueDigest('validated-material-approval'),
      approvedAt: 234,
      previousApprovalDigest: firstApproval.digest,
    })
    const exportBytes = (await f.meta.receiptExport(f.row.runId))!.bytes
    await handle.recordApproval!(firstApproval)
    await handle.recordApproval!(latestApproval)
    await handle.recordApproval!(firstApproval)
    expect(await handle.trace().approvals!(f.row.runId)).toEqual([firstApproval, latestApproval])
    expect((await f.meta.receiptExport(f.row.runId))!.bytes).toEqual(exportBytes)
    const receipt = createActivationReceipt({
      version: 1,
      operationId: h.operationId,
      runId: f.row.runId,
      kind: 'epoch-conversion',
      deployment: 'standalone',
      role: 'converted',
      source: {
        location: {
          kind: 'sqlite-file',
          path: '/frozen/source.sqlite',
          pointerPath: '/source/pointer.json',
        },
        provider: h.sourceProvider,
        epoch: 1,
        generationId: f.plan.sourceGenerationId,
        fingerprintDigest: f.plan.sourceFingerprint,
        sourceVersion: f.plan.sourceVersion,
        watermark: f.plan.sourceWatermark,
        preUpgradeWatermark: null,
      },
      target: {
        provider: h.targetProvider,
        epoch: 2,
        generationId: h.generationId,
        location: h.targetLocation,
        contractDigest: h.head.contract.contract.digest,
        planDigest: h.head[h.targetProvider].digest,
      },
      migrationPlanDigest: valueDigest('numeric-only-rerender'),
      approvalDigest: latestApproval.payload.approvalDigest,
      approvalRecordDigest: latestApproval.digest,
      conversionPlanDigest: f.plan.digest,
      bindingDigest: run.bindingDigest,
      summaryDigest: run.summaryDigest!,
      validationDigest: result.digest,
      receiptExportDigest: exported.digest,
      backup: {
        version: 1,
        id: 'backup',
        kind: 'immutable-backup-source',
        path: null,
        digest: valueDigest('backup'),
        sourceWatermark: f.plan.sourceWatermark,
        contentManifestDigest: null,
        createdAt: 123,
      },
      contentManifestDigest: f.plan.contentManifestDigest,
      writerDrain: (await collectMigrationRows(f.meta.records(f.row.runId)))
        .filter((row) => row.kind === 'writer-drain')
        .map((row) => row.payload),
      familyCutoverSource: (await collectMigrationRows(f.meta.records(f.row.runId)))
        .filter((row) => row.kind === 'family-cutover-source')
        .map((row) => row.payload),
      lineage: (await collectMigrationRows(f.meta.records(f.row.runId))).filter(
        (row) => row.kind === 'source-generation' || row.kind === 'source-journal',
      ),
      identityHighWater: await f.meta.identityHighWater(f.row.runId),
      historyRestrictionsDigest: result.historyRestrictionsDigest,
      operatorDecisions: [...f.input.operatorDecisions!].reverse(),
      acknowledgementsDigest: valueDigest([...f.input.operatorDecisions!].reverse()),
      candidateBuild: f.plan.candidateBuild,
      previousPointer: { bytesBase64: null, digest: null, generationId: null },
      restoreFiles: [],
      preparedAt: 123,
    })
    expect(receipt.payload.operatorDecisions).toEqual(
      canonicalOperatorDecisions(f.input.operatorDecisions!),
    )
    expect(receipt.payload.operatorDecisions).toHaveLength(3)
    await expect(
      handle.prepareActivation(
        createActivationReceipt({
          ...receipt.payload,
          approvalDigest: firstApproval.payload.approvalDigest,
          approvalRecordDigest: firstApproval.digest,
        }),
        null,
      ),
    ).rejects.toThrow('v3-activation-approval-mismatch')
    const port = createTargetGenerationPort({
      appHome: h.appHome,
      registry: persistenceSchema,
      head: h.head,
      catalogCache: h.catalogCache,
      postgresql: {
        open: async () => openConversionTarget({ runtime: h.runtime }),
        preflight: async () => {
          throw new Error('unused-preflight')
        },
      },
    })
    let fault: EpochSwitchFaultPoint | null = 'after-deferred-constraints'
    const reopened = await port.open({
      generationId: h.generationId,
      provider: h.targetProvider,
      location: h.targetLocation,
      faults: (point) => {
        if (point === fault) throw new Error(`crash:${point}`)
      },
    })
    try {
      for (const point of [
        'after-deferred-constraints',
        'after-identity-high-water',
        'after-integrity-check',
        'after-catalog-admission',
      ] as const) {
        fault = point
        await expect(reopened.finalize({ runId: f.row.runId })).rejects.toThrow(`crash:${point}`)
      }
      fault = 'after-meta-receipt'
      await expect(reopened.prepareActivation(receipt, null)).rejects.toThrow(
        'crash:after-meta-receipt',
      )
      expect(
        await f.meta.select('activation_receipts', { generationId: h.generationId }),
      ).toHaveLength(1)
      fault = null
      await reopened.prepareActivation(receipt, null)
      await reopened.prepareActivation(receipt, null)
    } finally {
      await reopened.close()
    }
    expect((await f.meta.migrationRun(f.row.runId))!.approvalDigest).toBe(
      firstApproval.payload.approvalDigest,
    )
    const health = await handle.healthCheck([])
    const switchReceipt = createSwitchReceipt({
      version: 1,
      kind: 'verified',
      operationId: h.operationId,
      runId: f.row.runId,
      generationId: h.generationId,
      activationReceiptDigest: receipt.digest,
      pointerDigest: null,
      firstLiveWriteAt: null,
      health,
      retained: [],
      recordedAt: 345,
    })
    await handle.writeSwitchReceipt(switchReceipt)
    const completed = createSwitchReceipt({
      ...switchReceipt.payload,
      kind: 'completed',
      recordedAt: 346,
    })
    await handle.writeSwitchReceipt(completed)
    expect((await f.meta.migrationRun(f.row.runId))?.state).toBe('activated')
    await h.target.transaction((tx) => markFirstLiveWrite(tx, h.generationId, 456))
    await handle.writeSwitchReceipt(switchReceipt)
    await handle.writeSwitchReceipt(completed)
    await expect(
      handle.writeSwitchReceipt(createSwitchReceipt({ ...completed.payload, recordedAt: 999 })),
    ).rejects.toThrow('v3-switch-receipt-conflict')
    expect(await f.meta.select('switch_receipts', { generationId: h.generationId })).toHaveLength(2)
    expect(await handle.retireIfUnwritten()).toBe('written')
    expect((await f.meta.select('generations', { generationId: h.generationId }))[0]?.state).toBe(
      'active',
    )
  })
  test('unwritten prepared targets retire idempotently and never mark a business write', async () => {
    const f = await fixture(h)
    await h.target.transaction((tx) =>
      f.meta.withConnection(tx).insert('generations', {
        generationId: h.generationId,
        schemaEpoch: 2,
        role: 'converted',
        state: 'prepared',
        provider: h.targetProvider,
        operationId: h.operationId,
        runId: f.row.runId,
        sourceGenerationId: f.plan.sourceGenerationId,
        contractDigest: h.head.contract.contract.digest,
        planDigest: h.head[h.targetProvider].digest,
        activationReceiptDigest: null,
        createdAt: 123,
        activatedAt: null,
        retiredAt: null,
      }),
    )
    const handle = createTargetGenerationHandle({
      target: h.target,
      generationId: h.generationId,
      registry: persistenceSchema,
      head: h.head,
      catalogCache: h.catalogCache,
    })
    expect(await handle.retireIfUnwritten()).toBe('retired')
    expect(await handle.retireIfUnwritten()).toBe('already-retired')
    expect(await handle.firstLiveWriteAt()).toBeNull()
    const rollback = createRollbackReceipt({
      version: 1,
      kind: 'rolled-back',
      operationId: h.operationId,
      runId: f.row.runId,
      generationId: h.generationId,
      activationReceiptDigest: null,
      previousPointerDigest: null,
      restoredPointerDigest: null,
      firstLiveWriteAt: null,
      targetState: 'retired',
      restoredFiles: [],
      recordedAt: 123,
    })
    await handle.writeSwitchReceipt(rollback)
    await handle.writeSwitchReceipt(rollback)
    expect(
      await f.meta.select('switch_receipts', { generationId: h.generationId, kind: 'rolled-back' }),
    ).toHaveLength(1)
    await expect(
      handle.writeSwitchReceipt(
        createRollbackReceipt({
          ...rollback.payload,
          activationReceiptDigest: valueDigest('uncommitted-file'),
        }),
      ),
    ).rejects.toThrow('v3-switch-receipt-binding-mismatch')
  })
  const cases: readonly ValidationCheck[] = [
    'coverage',
    'engine-blocks',
    'load-blocks',
    'receipt-conservation',
    'constraints',
    'integrity',
    'catalog',
    'identity',
    'required-seeds',
    'content',
    'history-restrictions',
    'probes',
  ]
  test('transient probe retries and every declared family seed is required without reseeding', async () => {
    const f = await fixture(h)
    await runConversion(f.input, f.sink)
    const handle = createTargetGenerationHandle({
      target: h.target,
      generationId: h.generationId,
      registry: persistenceSchema,
      head: h.head,
      catalogCache: h.catalogCache,
    })
    let fails = true
    const request = {
      runId: f.row.runId,
      preflight: f.input.preflight,
      preUpgrade: null,
      inventory: {
        ...f.input.content,
        async verifyUnchanged() {
          return []
        },
      },
      probes: [
        {
          id: 'transient',
          async run() {
            return { id: 'transient', passed: !fails, detail: null }
          },
        },
      ],
    }
    expect((await handle.validate(request)).passed).toBe(false)
    expect((await f.meta.blocks({ runId: f.row.runId })).map((row) => row.block.code)).toContain(
      'v3-validation-probes',
    )
    fails = false
    const retried = await handle.validate(request)
    expect(retried.checks.filter((check) => !check.passed)).toEqual([])
    expect(retried.passed).toBe(true)
    expect(
      (await f.meta.blocks({ runId: f.row.runId })).filter((row) => row.origin === 'validation'),
    ).toEqual([])
    const seeds = persistenceSchema.contributions
      .flatMap((contribution: SchemaContribution) => contribution.seeds ?? [])
      .filter((seed) => seed.table === 'committed_event_family_cutovers')
      .flatMap((seed) => seed.rows)
      .map(
        (seed): TargetRow =>
          Object.fromEntries(
            Object.entries(seed).map(([name, value]) => {
              if (typeof value === 'object' && value !== null)
                throw new Error('family seed must contain literal values')
              return [name, value]
            }),
          ),
      )
    expect(seeds).toHaveLength(4)
    for (const seed of seeds) {
      const table = targetTableName(h.targetProvider, 'committed_event_family_cutovers')
      await h.target.execute(
        `DELETE FROM ${table} WHERE producer = '${seed.producer}' AND family = '${seed.family}'`,
      )
      const result = await handle.validate(request)
      expect(result.checks.find((check) => check.check === 'required-seeds')?.passed).toBe(false)
      expect(
        await f.meta.probeTarget({
          table: 'committed_event_family_cutovers',
          key: encodeMigrationKey('committed_event_family_cutovers', [
            canonicalValue(String(seed.producer)),
            canonicalValue(String(seed.family)),
          ]),
        }),
      ).toBe(false)
      await expect(
        handle.exportReceipts({ runId: f.row.runId, operationRoot: h.operationRoot }),
      ).rejects.toThrow('v3-receipt-export-before-validation')
      await h.target.transaction((tx) =>
        f.loader.insert(tx, [{ table: 'committed_event_family_cutovers', rows: [seed] }]),
      )
      expect((await handle.validate(request)).passed).toBe(true)
      expect(
        (await f.meta.blocks({ runId: f.row.runId })).filter((row) => row.origin === 'validation'),
      ).toEqual([])
    }
  })
  for (const check of cases)
    test(`${check} failure blocks validation and receipt export`, async () => {
      const f = await fixture(h)
      await f.sink.open(f.binding)
      await f.sink.finish(f.summary)
      const actualRun = (await f.meta.migrationRun(f.row.runId))!
      const success: TargetFinalizeReport = {
        version: 1,
        runId: f.row.runId,
        deferredConstraintsApplied: true,
        violations: [],
        integrity: [],
        catalogAdmitted: true,
        identityHighWater: [],
        identityVerified: true,
        digest: valueDigest('finalize'),
      }
      const emptyPreflight = { ...f.input.preflight, tables: [] }
      const meta = {
        ...f.meta,
        migrationRun: async () =>
          check === 'coverage'
            ? {
                ...actualRun,
                conversionPlan: { ...actualRun.conversionPlan, coverage: 'partial' as const },
              }
            : actualRun,
        tableReceipts: async () => [],
        blocks: async () =>
          check === 'engine-blocks' || check === 'load-blocks'
            ? [
                {
                  runId: f.row.runId,
                  origin: check === 'load-blocks' ? ('load' as const) : ('plan' as const),
                  unitId: null,
                  ordinal: 0,
                  block: {
                    code: 'blocked',
                    scope: 'global' as const,
                    sourceTable: null,
                    sourceKey: null,
                    taskId: null,
                    runId: null,
                    missingFields: [],
                    detail: null,
                  },
                },
              ]
            : [],
        probeTarget: async () => check !== 'required-seeds',
        async *dispositions() {
          if (check === 'history-restrictions')
            yield {
              sourceTable: 'maintenance_state',
              sourceKey: encodeMigrationKey('maintenance_state', [canonicalValue('a')]),
              class: 'preserved' as const,
              kind: 'history-only' as const,
              targets: [],
              archive: null,
              rule: { id: 'r', version: 1 },
              decision: null,
              history: {
                taskId: 't',
                runId: null,
                execution: 'terminal-history' as const,
                missingFields: [],
              },
            }
        },
      }
      const result = await validateConversionRun({
        target: h.target,
        meta,
        registry: persistenceSchema,
        runId: f.row.runId,
        preflight: check === 'receipt-conservation' ? f.input.preflight : emptyPreflight,
        preUpgrade: null,
        inventory: {
          ...f.input.content,
          async verifyUnchanged() {
            if (check === 'content') throw new Error('drift')
            return []
          },
        },
        probes: [
          {
            id: 'probe',
            async run() {
              return { id: 'probe', passed: check !== 'probes', detail: null }
            },
          },
        ],
        finalized: {
          ...success,
          deferredConstraintsApplied: check !== 'constraints',
          integrity: check === 'integrity' ? ['failed'] : [],
          catalogAdmitted: check !== 'catalog',
          identityVerified: check !== 'identity',
        },
        now: () => 123,
      })
      expect(result.checks.find((entry) => entry.check === check)?.passed).toBe(false)
      expect(result.passed).toBe(false)
      const handle = createTargetGenerationHandle({
        target: h.target,
        generationId: h.generationId,
        registry: persistenceSchema,
        head: h.head,
        catalogCache: h.catalogCache,
      })
      await expect(
        handle.exportReceipts({ runId: f.row.runId, operationRoot: h.operationRoot }),
      ).rejects.toThrow('v3-receipt-export-before-validation')
    })
})
