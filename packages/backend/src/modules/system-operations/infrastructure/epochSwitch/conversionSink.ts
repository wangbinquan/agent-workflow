import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { encodeStagedValue } from '@/platform/persistence/migration/conversion/staging'
import { decodeMigrationKey } from '@/platform/persistence/migration/conversion/migrationKey'
import type { ConversionSink } from '@/platform/persistence/migration/conversion/sink'
import type { ConversionBlock, UnitOutput } from '@/platform/persistence/migration/conversion/types'
import type {
  ConversionTargetConnection,
  MigrationRunInit,
  TargetInsertRejection,
  UnitProgress,
} from '@/platform/persistence/migration/run/types'
import { TargetLoadError, type TargetLoader } from '@/platform/persistence/migration/target/loader'
import { collectMigrationRows, type MigrationMetaStore } from './metaStore'

export function assertMigrationUnitDigest(output: UnitOutput): void {
  const { digest, ...receipt } = output.receipt
  const { receipt: _receipt, ...payload } = output
  if (valueDigest({ receipt, output: encodeStagedValue(payload) }) !== digest)
    throw new Error('v3-sink-invalid-unit-digest')
}
function loadBlock(output: UnitOutput, rejected: TargetInsertRejection): ConversionBlock {
  const decoded = decodeMigrationKey(rejected.targetKey)
  const source = output.receipt.sources.find(
    (source) =>
      source.table === decoded.table &&
      source.firstKey !== null &&
      source.lastKey !== null &&
      Buffer.compare(Buffer.from(rejected.targetKey), Buffer.from(source.firstKey)) >= 0 &&
      Buffer.compare(Buffer.from(rejected.targetKey), Buffer.from(source.lastKey)) <= 0 &&
      !output.dispositions.some(
        (row) =>
          row.targets.some(
            (target) => target.key === rejected.targetKey && target.table === rejected.table,
          ) && row.sourceKey !== rejected.targetKey,
      ),
  )
  return {
    code: 'v3-target-load-rejected',
    scope: source ? 'row' : 'global',
    sourceTable: source?.table ?? null,
    sourceKey: source ? rejected.targetKey : null,
    ...(source ? { sourcePhase: source.phase } : {}),
    taskId: null,
    runId: null,
    missingFields: [],
    detail: {
      unitId: output.receipt.unitId,
      targetTable: rejected.table,
      targetKey: rejected.targetKey,
      constraint: rejected.constraint,
      message: rejected.message,
    },
  }
}
export function createTargetConversionSink(input: {
  target: ConversionTargetConnection
  loader: TargetLoader
  meta: MigrationMetaStore
  run: MigrationRunInit
  now: () => number
  onUnit?: (progress: UnitProgress) => void
  fault?: (point: 'after-rows' | 'after-receipts' | 'before-ack') => void
}): ConversionSink & { loadBlocks(): Promise<readonly ConversionBlock[]> } {
  let opened = false
  return {
    async open(binding) {
      const result = await input.target.transaction(async (tx) => {
        const meta = input.meta.withConnection(tx)
        await meta.openRun(input.run, binding)
        return {
          committedUnitIds: new Set(
            (await collectMigrationRows(meta.units(input.run.runId))).map((unit) => unit.unitId),
          ),
        }
      })
      opened = true
      return result
    },
    async commitUnit(output) {
      if (!opened) throw new Error('v3-sink-not-open')
      assertMigrationUnitDigest(output)
      const progress = await input.target.transaction(async (tx): Promise<UnitProgress> => {
        const meta = input.meta.withConnection(tx)
        const runId = input.run.runId
        const unitId = output.receipt.unitId
        const previous = await meta.unit(runId, unitId)
        if (previous) {
          if (previous.receipt.digest !== output.receipt.digest)
            throw new Error('v3-sink-unit-conflict')
          return {
            runId,
            unitId,
            rule: output.receipt.rule,
            outcome: previous.outcome,
            rowsWritten: previous.rowsWritten,
            replayed: true,
          }
        }
        const run = await meta.migrationRun(runId)
        if (!run || run.state !== 'open') throw new Error('v3-sink-run-finished')
        let blocks: readonly ConversionBlock[] = []
        await tx.execute('SAVEPOINT v3_unit_rows')
        try {
          await input.loader.insert(tx, output.rows)
        } catch (error) {
          await tx.execute('ROLLBACK TO SAVEPOINT v3_unit_rows')
          if (!(error instanceof TargetLoadError)) throw error
          const rejections = await input.loader.locate(tx, output.rows)
          blocks = rejections.map((rejected) => loadBlock(output, rejected))
          if (!blocks.length)
            blocks = [
              {
                code: 'v3-target-load-rejected',
                scope: 'global',
                sourceTable: null,
                sourceKey: null,
                taskId: null,
                runId: null,
                missingFields: [],
                detail: { unitId, ...error.rejection },
              },
            ]
        } finally {
          await tx.execute('RELEASE SAVEPOINT v3_unit_rows')
        }
        const outcome = blocks.length ? 'load-blocked' : 'committed'
        if (!blocks.length) input.fault?.('after-rows')
        await meta.writeUnit(runId, output, outcome, input.now(), blocks)
        input.fault?.('after-receipts')
        return {
          runId,
          unitId,
          rule: output.receipt.rule,
          outcome,
          rowsWritten: blocks.length
            ? 0
            : output.rows.reduce((sum, group) => sum + group.rows.length, 0),
          replayed: false,
        }
      })
      input.fault?.('before-ack')
      input.onUnit?.(progress)
    },
    async finish(summary) {
      if (!opened) throw new Error('v3-sink-not-open')
      await input.target.transaction((tx) =>
        input.meta.withConnection(tx).finishRun(input.run.runId, summary, input.now()),
      )
    },
    async loadBlocks() {
      return (await input.meta.blocks({ runId: input.run.runId }))
        .filter((row) => row.origin === 'load')
        .map((row) => row.block)
    },
  }
}
