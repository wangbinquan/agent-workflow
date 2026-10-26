import { persistenceDialect } from '@/platform/persistence/nativeDialect'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import type { SchemaRegistry } from '@/platform/persistence/schema/registry'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { ConversionBlock, JsonValue } from '@/platform/persistence/migration/conversion/types'
import type { SourcePreflight } from '@/platform/persistence/migration/sourceTypes'
import type {
  ConversionTargetConnection,
  ProbeResult,
  ReadOnlyProbe,
  TargetFinalizeReport,
  ValidationReport,
  VerifiableContentInventory,
} from '@/platform/persistence/migration/run/types'
import { collectMigrationRows, type MigrationMetaStore } from './metaStore'
import { historyRestrictionsDigest } from './historyRestrictions'

export async function runReadOnlyProbes(
  target: ConversionTargetConnection,
  probes: readonly ReadOnlyProbe[],
): Promise<readonly ProbeResult[]> {
  return target.transaction(async (tx) => {
    await tx.execute(persistenceDialect(tx.provider).readOnly)
    const results: ProbeResult[] = []
    try {
      for (const probe of probes) {
        await tx.execute('SAVEPOINT v3_readonly_probe')
        try {
          const result = await probe.run({
            provider: tx.provider,
            query: (sql, values) => tx.execute(sql, values),
          })
          results.push({ ...result, id: probe.id })
        } catch (error) {
          await tx.execute('ROLLBACK TO SAVEPOINT v3_readonly_probe')
          results.push({
            id: probe.id,
            passed: false,
            detail: { message: error instanceof Error ? error.message : String(error) },
          })
        } finally {
          await tx.execute('RELEASE SAVEPOINT v3_readonly_probe')
        }
      }
    } finally {
      for (const sql of persistenceDialect(tx.provider).endReadOnly) await tx.execute(sql)
    }
    return results
  })
}
export async function validateConversionRun(input: {
  target: ConversionTargetConnection
  meta: MigrationMetaStore
  registry: SchemaRegistry
  runId: string
  preflight: SourcePreflight
  preUpgrade: SourcePreflight | null
  inventory: VerifiableContentInventory
  probes: readonly ReadOnlyProbe[]
  finalized: TargetFinalizeReport
  now: () => number
}): Promise<ValidationReport> {
  const { meta, runId, finalized } = input
  const run = await meta.migrationRun(runId)
  if (!run?.summaryDigest) throw new Error('v3-validation-before-finish')
  if (run.receiptExportDigest && run.validation) return run.validation
  const checks: ValidationReport['checks'][number][] = []
  const add = (
    check: ValidationReport['checks'][number]['check'],
    passed: boolean,
    detail: JsonValue,
  ) => checks.push({ check, passed, detail })
  add(
    'coverage',
    run.conversionPlan.coverage === 'complete' && run.conversionPlan.blocks.length === 0,
    { coverage: run.conversionPlan.coverage },
  )
  const blocks = await meta.blocks({ runId })
  const engineBlocks = blocks.filter((row) => row.origin === 'unit' || row.origin === 'plan')
  const loadBlocks = blocks.filter((row) => row.origin === 'load')
  add('engine-blocks', engineBlocks.length === 0, { count: engineBlocks.length })
  add('load-blocks', loadBlocks.length === 0, { count: loadBlocks.length })
  const receipts = await meta.tableReceipts(runId)
  const units = await collectMigrationRows(meta.units(runId))
  const expected = [
    ...input.preflight.tables.map((table) => ({ ...table, phase: 'current' as const })),
    ...(input.preUpgrade?.tables ?? [])
      .filter((table) =>
        run.conversionPlan.tables.some(
          (entry) => entry.phase === 'pre-upgrade' && entry.table === table.table,
        ),
      )
      .map((table) => ({ ...table, phase: 'pre-upgrade' as const })),
  ]
  const mismatches: string[] = []
  if (
    run.binding.sourceWatermark !== input.preflight.watermark ||
    run.binding.preUpgradeWatermark !== (input.preUpgrade?.watermark ?? null)
  )
    mismatches.push('source-watermark')
  for (const table of expected) {
    const receipt = receipts.find(
      (row) => row.sourceTable === table.table && row.sourcePhase === table.phase,
    )
    const sources = units.flatMap((unit) =>
      unit.receipt.sources.filter(
        (source) => source.table === table.table && source.phase === table.phase,
      ),
    )
    if (
      !receipt ||
      receipt.rowsRead !== table.rows ||
      Object.values(receipt.counts).reduce((sum, n) => sum + n, 0) !== receipt.rowsRead ||
      receipt.units !== sources.length ||
      sources.reduce((sum, source) => sum + source.rows, 0) !== receipt.rowsRead ||
      sources.some(
        (source) => Object.values(source.counts).reduce((sum, n) => sum + n, 0) !== source.rows,
      )
    )
      mismatches.push(`${table.phase}:${table.table}`)
  }
  if (receipts.length !== expected.length) mismatches.push('table-receipt-roster')
  add('receipt-conservation', mismatches.length === 0, { mismatches })
  add(
    'constraints',
    finalized.runId === runId &&
      finalized.deferredConstraintsApplied &&
      finalized.violations.length === 0,
    { violations: finalized.violations.map((row) => ({ ...row })) },
  )
  add('integrity', finalized.integrity.length === 0, { messages: finalized.integrity })
  add('catalog', finalized.catalogAdmitted, { admitted: finalized.catalogAdmitted })
  add('identity', finalized.identityVerified, { verified: finalized.identityVerified })
  const missingSeeds: string[] = []
  for (const contribution of input.registry.contributions)
    for (const seed of contribution.seeds ?? []) {
      const table = input.registry.tables.find((table) => table.id === seed.table)
      if (!table) throw new Error(`v3-seed-table-missing: ${seed.table}`)
      for (const row of seed.rows) {
        const key = encodeMigrationKey(
          seed.table,
          table.primaryKey.map((name) => {
            const column = Object.values(table.columns).find((column) => column.name === name)!
            const value = Object.hasOwn(row, name)
              ? row[name]
              : column.default.kind === 'literal'
                ? column.default.value
                : undefined
            if (value === undefined || (typeof value === 'object' && value !== null))
              throw new Error(`v3-seed-key-not-literal: ${seed.table}.${name}`)
            return canonicalValue(value)
          }),
        )
        if (!(await meta.probeTarget({ table: seed.table, key }))) missingSeeds.push(key)
      }
    }
  add('required-seeds', missingSeeds.length === 0, { missing: missingSeeds })
  let contentDrift: ValidationReport['contentDrift'] = []
  let contentError: string | null = null
  try {
    contentDrift = await input.inventory.verifyUnchanged(meta.artifacts({ runId }))
  } catch (error) {
    contentError = error instanceof Error ? error.message : String(error)
  }
  add('content', contentError === null && contentDrift.length === 0, {
    drift: contentDrift.map((row) => ({ ...row })),
    error: contentError,
  })
  const restrictions = await meta.restrictions({ runId })
  const historyDispositions = (await collectMigrationRows(meta.dispositions({ runId }))).filter(
    (row) => row.history,
  )
  const restrictionDigest = historyRestrictionsDigest(restrictions)
  const restrictionsMatch =
    restrictions.length === historyDispositions.length &&
    historyDispositions.every((row) =>
      restrictions.some(
        (entry) =>
          entry.sourceTable === row.sourceTable &&
          entry.sourceKey === row.sourceKey &&
          entry.sourcePhase === (row.sourcePhase ?? 'current') &&
          valueDigest(entry.history) === valueDigest(row.history),
      ),
    )
  add('history-restrictions', restrictionsMatch, {
    digest: restrictionDigest,
    count: restrictions.length,
  })
  const probes = await runReadOnlyProbes(input.target, input.probes)
  add(
    'probes',
    probes.every((probe) => probe.passed),
    { results: probes.map((probe) => ({ ...probe })) },
  )
  const validationBlocks: ConversionBlock[] = checks
    .filter((check) => !check.passed)
    .map((check) => ({
      code: `v3-validation-${check.check}`,
      scope: 'global',
      sourceTable: null,
      sourceKey: null,
      taskId: null,
      runId: null,
      missingFields: [],
      detail: check.detail,
    }))
  const payload = {
    version: 1 as const,
    runId,
    validatedAt: input.now(),
    passed: checks.every((check) => check.passed),
    checks,
    blocks: validationBlocks,
    contentDrift,
    historyRestrictionsDigest: restrictionDigest,
    probes,
  }
  const report = { ...payload, digest: valueDigest(payload) }
  await input.target.transaction((tx) => meta.withConnection(tx).saveValidation(report))
  return report
}
