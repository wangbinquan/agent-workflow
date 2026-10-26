import { persistenceDialect } from '@/platform/persistence/nativeDialect'
import { z } from 'zod'
import type { SchemaRegistry } from '@/platform/persistence/schema/registry'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { quoteSchemaIdentifier as quote } from '@/platform/persistence/schema/expressions'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import {
  parameters,
  type HistoryConnection,
} from '@/platform/persistence/schema/history/connection'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { decodeMigrationKey } from '@/platform/persistence/migration/conversion/migrationKey'
import { decodeLogicalValue } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import type {
  ConversionRunBinding,
  ConversionSummary,
} from '@/platform/persistence/migration/conversion/sink'
import type {
  ArtifactReceipt,
  ConversionBlock,
  MigrationRecord,
  TableReceipt,
  TargetValue,
  UnitOutput,
} from '@/platform/persistence/migration/conversion/types'
import type {
  ConversionTargetConnection,
  FoldedIdentityHighWater,
  MigrationArchive,
  MigrationApproval,
  MigrationBlockRecord,
  MigrationRun,
  MigrationRunInit,
  MigrationUnit,
  MigrationUnitSource,
  PersistedHistoryRestriction,
  ReceiptExport,
  ValidationReport,
} from '@/platform/persistence/migration/run/types'
import { VALIDATION_CHECKS } from '@/platform/persistence/migration/run/types'
import { probeTargetRow } from '@/platform/persistence/migration/target/loader'
import { foldIdentityHighWater } from '@/platform/persistence/migration/target/identity'
import type { MigrationMetaReadPort } from '../../application/ports/epochSwitch'
import {
  ConversionPlanSectionSchema,
  MigrationRowDispositionSchema,
  ValidationReportSchema,
  appendMigrationApproval,
} from '../../domain/epochSwitch/documents'
import {
  MigrationApprovalHistorySchema,
  MigrationApprovalSchema,
} from '../../domain/epochSwitch/model'
import { EPOCH2_META_TABLES } from '../persistence/migrationMetaTables'

export async function collectMigrationRows<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const row of rows) result.push(row)
  return result
}
export function compareMigrationBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}
type MetaRow = Readonly<Record<string, unknown>>
export interface MigrationMetaStore extends MigrationMetaReadPort {
  readonly connection: HistoryConnection
  withConnection(tx: HistoryConnection): MigrationMetaStore
  select(table: string, where?: MetaRow): Promise<readonly MetaRow[]>
  insert(table: string, row: MetaRow): Promise<void>
  update(table: string, where: MetaRow, row: MetaRow): Promise<void>
  openRun(row: MigrationRunInit, binding: ConversionRunBinding): Promise<MigrationRun>
  approvals(runId: string): Promise<readonly MigrationApproval[]>
  recordApproval(approval: MigrationApproval): Promise<void>
  unit(runId: string, unitId: string): Promise<MigrationUnit | null>
  writeUnit(
    runId: string,
    output: UnitOutput,
    outcome: MigrationUnit['outcome'],
    now: number,
    loadBlocks?: readonly ConversionBlock[],
  ): Promise<void>
  writeBlocks(
    runId: string,
    origin: MigrationBlockRecord['origin'],
    unitId: string | null,
    blocks: readonly ConversionBlock[],
  ): Promise<void>
  finishRun(runId: string, summary: ConversionSummary, now: number): Promise<void>
  saveValidation(report: ValidationReport): Promise<void>
  saveIdentity(
    runId: string,
    values: readonly FoldedIdentityHighWater[],
    appliedAt: number | null,
  ): Promise<void>
  saveExport(runId: string, value: ReceiptExport & { readonly bytes: Uint8Array }): Promise<void>
}
export function createMigrationMetaStore(input: {
  target: ConversionTargetConnection | HistoryConnection
  registry: SchemaRegistry
}): MigrationMetaStore {
  const tx = input.target
  const declarations = new Map(EPOCH2_META_TABLES.map((table) => [table.name, table]))
  const declaration = (name: string) => {
    const table = declarations.get(name)
    if (!table) throw new Error(`v3-meta-table: ${name}`)
    return table
  }
  const encode = (name: string, row: MetaRow) =>
    Object.entries(row).map(([key, value]) => {
      const column = declaration(name).columns[key]
      if (!column) throw new Error(`v3-meta-column: ${name}.${key}`)
      if (value === null && column.nullable) return { name: column.name, value: null }
      let encoded: unknown = value
      if (column.codec === 'jsonText') encoded = canonicalSchemaJson(value)
      else if (column.codec === 'bool') {
        z.boolean().parse(value)
        encoded = persistenceDialect(tx.provider).boolean(value as boolean)
      } else if (column.codec === 'bytes') z.instanceof(Uint8Array).parse(value)
      else if (['int', 'epochMs', 'bigint'].includes(column.codec)) {
        z.union([z.number().int().safe(), z.bigint()]).parse(value)
        encoded = persistenceDialect(tx.provider).integer(value as number | bigint)
      } else {
        z.string().parse(value)
        if (column.enumValues && !column.enumValues.includes(String(value)))
          throw new Error(`v3-meta-enum: ${name}.${key}`)
      }
      return { name: column.name, value: encoded }
    })
  const decode = (name: string, row: Record<string, unknown>): MetaRow =>
    Object.fromEntries(
      Object.entries(declaration(name).columns).map(([key, column]) => {
        let value = row[column.name]
        if (value !== null && value !== undefined) {
          if (column.codec === 'jsonText') value = JSON.parse(String(value)) as unknown
          else if (column.codec === 'bool') value = value === true || Number(value) === 1
          else if (['int', 'epochMs', 'bigint'].includes(column.codec))
            value = z.number().int().safe().parse(Number(value))
          else if (column.codec === 'bytes') value = new Uint8Array(value as Uint8Array)
        }
        return [key, value]
      }),
    )
  const whereSql = (entries: ReturnType<typeof encode>, offset = 0) =>
    entries
      .map(
        (entry, index) =>
          `${quote(entry.name)} = ${persistenceDialect(tx.provider).parameter(offset + index + 1)}`,
      )
      .join(' AND ')
  const select = async (table: string, where: MetaRow = {}): Promise<readonly MetaRow[]> => {
    const entries = encode(table, where)
    const rows = await tx.execute(
      `SELECT * FROM ${metaTableName(tx.provider, table)}${entries.length ? ` WHERE ${whereSql(entries)}` : ''}`,
      entries.map((entry) => entry.value),
    )
    return rows
      .map((row) => decode(table, row))
      .sort((a, b) => compareMigrationBytes(canonicalSchemaJson(a), canonicalSchemaJson(b)))
  }
  const insert = async (table: string, row: MetaRow): Promise<void> => {
    if (Object.keys(row).length !== Object.keys(declaration(table).columns).length)
      throw new Error(`v3-meta-incomplete-row: ${table}`)
    const entries = encode(table, row)
    await tx.execute(
      `INSERT INTO ${metaTableName(tx.provider, table)} (${entries.map((entry) => quote(entry.name)).join(', ')}) VALUES (${parameters(tx, entries.length)})`,
      entries.map((entry) => entry.value),
    )
  }
  const update = async (table: string, where: MetaRow, row: MetaRow): Promise<void> => {
    const entries = encode(table, row)
    const keys = encode(table, where)
    if (!keys.length) throw new Error('v3-meta-update-key-required')
    await tx.execute(
      `UPDATE ${metaTableName(tx.provider, table)} SET ${entries.map((entry, index) => `${quote(entry.name)} = ${persistenceDialect(tx.provider).parameter(index + 1)}`).join(', ')} WHERE ${whereSql(keys, entries.length)}`,
      [...entries, ...keys].map((entry) => entry.value),
    )
  }
  const decodeUnit = (row: MetaRow): MigrationUnit => ({
    runId: String(row.runId),
    unitId: String(row.unitId),
    receipt: row.receiptJson as MigrationUnit['receipt'],
    outcome: row.outcome as MigrationUnit['outcome'],
    rowsWritten: Number(row.rowsWritten),
    committedAt: Number(row.committedAt),
  })
  const store: MigrationMetaStore = {
    connection: tx,
    select,
    insert,
    update,
    withConnection: (connection) => createMigrationMetaStore({ ...input, target: connection }),
    async migrationRun(runId) {
      const row = (await select('migration_runs', { runId }))[0]
      if (!row) return null
      const inputs = await select('migration_operator_inputs', {
        runId,
        kind: 'archive-empty-table',
      })
      return {
        version: 1,
        runId,
        operationId: String(row.operationId),
        ordinal: Number(row.ordinal),
        kind: row.kind as MigrationRun['kind'],
        role: row.role as MigrationRun['role'],
        sourceProvider: row.sourceProvider as MigrationRun['sourceProvider'],
        sourceEpoch: 1,
        sourceKind: row.sourceKind as MigrationRun['sourceKind'],
        targetProvider: row.targetProvider as MigrationRun['targetProvider'],
        targetEpoch: 2,
        migrationPlanDigest: String(row.migrationPlanDigest),
        approvalDigest: String(row.approvalDigest),
        conversionPlan: ConversionPlanSectionSchema.parse(row.conversionPlanJson),
        emptyTables: [...inputs]
          .sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
          .map((entry) => entry.inputJson as MigrationRun['emptyTables'][number]),
        startedAt: Number(row.startedAt),
        state: row.state as MigrationRun['state'],
        binding: row.bindingJson as ConversionRunBinding,
        bindingDigest: String(row.bindingDigest),
        summaryDigest: row.summaryDigest as string | null,
        validation:
          row.validationJson === null ? null : ValidationReportSchema.parse(row.validationJson),
        validationDigest: row.validationDigest as string | null,
        receiptExportDigest: row.receiptExportDigest as string | null,
        convertedAt: row.convertedAt as number | null,
        validatedAt: row.validatedAt as number | null,
        completedAt: row.completedAt as number | null,
      }
    },
    async runs(operationId) {
      const rows = await select('migration_runs', { operationId })
      const runs = await Promise.all(rows.map((row) => store.migrationRun(String(row.runId))))
      return runs
        .filter((row): row is MigrationRun => row !== null)
        .sort((a, b) => a.ordinal - b.ordinal || compareMigrationBytes(a.runId, b.runId))
    },
    async approvals(runId) {
      const rows = await select('migration_approvals', { runId })
      return MigrationApprovalHistorySchema.parse(
        [...rows]
          .sort((a, b) => Number(a.sequence) - Number(b.sequence))
          .map((row) => row.receiptJson),
      )
    },
    async recordApproval(approval) {
      const checked = MigrationApprovalSchema.parse(approval)
      const p = checked.payload
      const run = await store.migrationRun(p.runId)
      if (!run || run.operationId !== p.operationId) throw new Error('v3-approval-run-mismatch')
      const history = await store.approvals(p.runId)
      const next = appendMigrationApproval(history, checked)
      if (next.length === history.length) return
      if (['activated', 'retired', 'discarded'].includes(run.state))
        throw new Error('v3-approval-frozen')
      await insert('migration_approvals', {
        runId: p.runId,
        sequence: p.sequence,
        operationId: p.operationId,
        planDigest: p.planDigest,
        approvalDigest: p.approvalDigest,
        approvedAt: p.approvedAt,
        previousApprovalDigest: p.previousApprovalDigest,
        receiptJson: checked,
        receiptDigest: checked.digest,
      })
    },
    async openRun(row, binding) {
      const existing = await store.migrationRun(row.runId)
      const plan = ConversionPlanSectionSchema.parse(row.conversionPlan)
      const { digest, ...payload } = plan
      if (valueDigest(payload) !== digest) throw new Error('v3-run-plan-digest-mismatch')
      const expected = {
        planDigest: plan.digest,
        sourceWatermark: plan.sourceWatermark,
        sourceVersion: plan.sourceVersion,
        sourceGenerationId: plan.sourceGenerationId,
        targetGeneration: plan.targetGeneration,
        converterVersion: plan.converterVersion,
        ruleSetDigest: plan.ruleSetDigest,
        preUpgradeWatermark: plan.preUpgradeWatermark,
      }
      if (
        Object.entries(expected).some(
          ([key, value]) => binding[key as keyof ConversionRunBinding] !== value,
        )
      )
        throw new Error('v3-run-binding-mismatch')
      if (existing) {
        const init = Object.fromEntries(
          Object.keys(row).map((key) => [key, existing[key as keyof MigrationRun]]),
        )
        if (
          existing.bindingDigest !== valueDigest(binding) ||
          valueDigest(existing.binding) !== valueDigest(binding) ||
          valueDigest(init) !== valueDigest(row)
        )
          throw new Error('v3-run-binding-mismatch')
        return existing
      }
      if (row.targetProvider !== tx.provider) throw new Error('v3-run-provider-mismatch')
      await insert('migration_runs', {
        runId: row.runId,
        operationId: row.operationId,
        ordinal: row.ordinal,
        state: 'open',
        kind: row.kind,
        role: row.role,
        sourceProvider: row.sourceProvider,
        sourceEpoch: row.sourceEpoch,
        sourceKind: row.sourceKind,
        sourceVersion: plan.sourceVersion,
        sourceFingerprint: plan.sourceFingerprint,
        sourceGenerationId: plan.sourceGenerationId,
        sourceWatermark: plan.sourceWatermark,
        preUpgradeWatermark: plan.preUpgradeWatermark,
        targetProvider: row.targetProvider,
        targetEpoch: row.targetEpoch,
        targetGenerationId: plan.targetGeneration,
        migrationPlanDigest: row.migrationPlanDigest,
        approvalDigest: row.approvalDigest,
        conversionPlanJson: plan,
        conversionPlanDigest: plan.digest,
        converterVersion: plan.converterVersion,
        ruleSetDigest: plan.ruleSetDigest,
        candidateBuild: plan.candidateBuild,
        sourceBackupId: plan.sourceBackupId,
        contentManifestDigest: plan.contentManifestDigest,
        planTime: plan.planTime,
        chunkLimit: plan.chunkLimit,
        bindingJson: binding,
        bindingDigest: valueDigest(binding),
        summaryDigest: null,
        validationJson: null,
        validationDigest: null,
        receiptExportDigest: null,
        startedAt: row.startedAt,
        convertedAt: null,
        validatedAt: null,
        completedAt: null,
      })
      for (const [ordinal, decision] of row.emptyTables.entries())
        await insert('migration_operator_inputs', {
          runId: row.runId,
          kind: 'archive-empty-table',
          ordinal,
          inputJson: decision,
          digest: valueDigest(decision),
        })
      for (const [ordinal, decision] of plan.operatorDecisions.entries())
        await insert('migration_operator_inputs', {
          runId: row.runId,
          kind: decision.kind,
          ordinal,
          inputJson: decision,
          digest: valueDigest(decision),
        })
      return (await store.migrationRun(row.runId))!
    },
    async unit(runId, unitId) {
      const row = (await select('migration_units', { runId, unitId }))[0]
      return row ? decodeUnit(row) : null
    },
    async *units(runId) {
      for (const row of await select('migration_units', { runId })) yield decodeUnit(row)
    },
    async unitSources(input) {
      const sources: MigrationUnitSource[] = []
      for (const row of await select('migration_unit_sources', input)) {
        const unit = await store.unit(input.runId, String(row.unitId))
        if (!unit) throw new Error('v3-meta-unit-missing')
        const receipt = unit.receipt.sources.find(
          (source) => source.table === input.sourceTable && source.phase === input.sourcePhase,
        )
        if (!receipt) throw new Error('v3-meta-unit-source-missing')
        sources.push({
          ...receipt,
          runId: input.runId,
          unitId: unit.unitId,
          rule: unit.receipt.rule,
          receiptDigest: unit.receipt.digest,
          unit: unit.receipt.unit,
        })
      }
      return sources
    },
    async tableReceipts(runId) {
      return (await select('migration_table_receipts', { runId })).map(
        (row) =>
          ({
            sourceTable: row.sourceTable,
            sourcePhase: row.sourcePhase,
            sourceVersion: row.sourceVersion,
            rowsRead: row.rowsRead,
            targets: row.targetsJson,
            counts: row.countsJson,
            exceptions: row.exceptions,
            historyOnly: row.historyOnly,
            keyDigest: row.keyDigest,
            contentDigest: row.contentDigest,
            units: row.units,
            activeClaims: row.activeClaimsJson,
          }) as TableReceipt,
      )
    },
    async *dispositions({ runId, source, unitId }) {
      for (const row of await select('migration_row_dispositions', {
        runId,
        ...source,
        ...(unitId === undefined ? {} : { unitId }),
      }))
        yield MigrationRowDispositionSchema.parse({
          sourceTable: row.sourceTable,
          sourceKey: row.sourceKey,
          sourcePhase: row.sourcePhase,
          class: row.class,
          kind: row.kind,
          targets: row.targetsJson,
          archive: row.archiveRef,
          rule: { id: row.ruleId, version: row.ruleVersion },
          decision: row.decisionJson,
          ...(row.historyJson === null ? {} : { history: row.historyJson }),
          ...(row.codecColumnsJson === null ? {} : { codecColumns: row.codecColumnsJson }),
          ...(row.allocationJson === null ? {} : { allocation: row.allocationJson }),
        })
    },
    async *artifacts(input) {
      for (const row of await select('migration_artifact_receipts', input))
        yield {
          sourceTable: String(row.sourceTable),
          sourceKey: row.sourceKey as ArtifactReceipt['sourceKey'],
          sourceColumn: String(row.sourceColumn),
          originalReference: row.originalReference as string | null,
          target: {
            table: String(row.targetTable),
            key: row.targetKey as ArtifactReceipt['target']['key'],
            contentId: row.contentId as string | null,
            backend: row.backend as ArtifactReceipt['target']['backend'],
          },
          bytes:
            row.sha256 === null ? null : { sha256: String(row.sha256), size: Number(row.size) },
          publication: row.publication as ArtifactReceipt['publication'],
          missing:
            row.missingState === null
              ? null
              : {
                  state: row.missingState as NonNullable<ArtifactReceipt['missing']>['state'],
                  evidence: String(row.missingEvidence),
                },
        }
    },
    async restrictions(input) {
      return (await select('migration_history_restrictions', input)).map(
        (row) =>
          ({
            runId: row.runId,
            unitId: row.unitId,
            ordinal: row.ordinal,
            sourceTable: row.sourceTable,
            sourcePhase: row.sourcePhase,
            sourceKey: row.sourceKey,
            decisionCode: row.decisionCode,
            history: {
              taskId: row.taskId,
              runId: row.nodeRunId,
              execution: row.execution,
              missingFields: row.missingFieldsJson,
              ...(row.executionUse === null
                ? {}
                : { executionUse: row.executionUse, reason: row.reason }),
            },
          }) as PersistedHistoryRestriction,
      )
    },
    async blocks(input) {
      return (await select('migration_blocks', input)).map(
        (row) =>
          ({
            runId: row.runId,
            origin: row.origin,
            unitId: row.unitId || null,
            ordinal: row.ordinal,
            block: {
              code: row.code,
              scope: row.scope,
              sourceTable: row.sourceTable,
              sourceKey: row.sourceKey,
              ...(row.sourcePhase === null ? {} : { sourcePhase: row.sourcePhase }),
              taskId: row.taskId,
              runId: row.nodeRunId,
              missingFields: row.missingFieldsJson,
              detail: row.detailJson,
              ...(row.acknowledgeable ? { acknowledgeable: true } : {}),
            },
          }) as MigrationBlockRecord,
      )
    },
    async *records(runId) {
      for (const row of await select('migration_records', { runId }))
        yield row.recordJson as MigrationRecord
    },
    async identityHighWater(runId) {
      return (await select('migration_identity_high_water', { runId })).map(
        (row) =>
          ({
            table: row.tableName,
            column: row.columnName,
            value: row.value,
            basis: row.basis,
            warnings: row.warningsJson,
          }) as FoldedIdentityHighWater,
      )
    },
    async archive({ runId, ref }) {
      const row = (await select('migration_archives', { runId, archiveRef: ref }))[0]
      return row
        ? ({
            ref,
            unitId: String(row.unitId),
            kind: row.kind,
            sourceTable: row.sourceTable,
            format: row.format,
            bytes: row.bytes,
            rows: row.rows,
          } as MigrationArchive)
        : null
    },
    async probeTarget(target) {
      const table = input.registry.tables.find((table) => table.id === target.table)
      const decoded = decodeMigrationKey(target.key)
      return table && decoded.table === table.id
        ? probeTargetRow(
            tx,
            table,
            decoded.key.map((cell) => decodeLogicalValue(cell) as TargetValue),
          )
        : false
    },
    async receiptExport(runId) {
      const row = (await select('migration_receipt_exports', { runId }))[0]
      return row
        ? {
            path: row.path as string | null,
            digest: String(row.digest),
            bytes: row.bytes as Uint8Array | null,
          }
        : null
    },
    async writeBlocks(runId, origin, unitId, blocks) {
      for (const [ordinal, block] of blocks.entries())
        await insert('migration_blocks', {
          runId,
          origin,
          unitId: unitId ?? '',
          ordinal,
          code: block.code,
          scope: block.scope,
          sourceTable: block.sourceTable,
          sourceKey: block.sourceKey,
          sourcePhase: block.sourcePhase ?? null,
          taskId: block.taskId,
          nodeRunId: block.runId,
          missingFieldsJson: block.missingFields,
          detailJson: block.detail,
          acknowledgeable: block.acknowledgeable ?? false,
        })
    },
    async writeUnit(runId, output, outcome, now, loadBlocks = []) {
      const receipt = output.receipt
      const unitId = receipt.unitId
      await insert('migration_units', {
        runId,
        unitId,
        ruleId: receipt.rule.id,
        ruleVersion: receipt.rule.version,
        unitJson: receipt.unit,
        receiptJson: receipt,
        receiptDigest: receipt.digest,
        outcome,
        rowsWritten:
          outcome === 'committed'
            ? output.rows.reduce((sum, group) => sum + group.rows.length, 0)
            : 0,
        committedAt: now,
      })
      for (const source of receipt.sources)
        await insert('migration_unit_sources', {
          runId,
          sourceTable: source.table,
          sourcePhase: source.phase,
          unitId,
          firstKey: source.firstKey,
          lastKey: source.lastKey,
          rows: source.rows,
          digest: source.digest,
          keyDigest: source.keyDigest,
          countsJson: source.counts,
          exceptions: source.exceptions,
          historyOnly: source.historyOnly,
          unitKind: receipt.unit.kind,
          firstGroup: receipt.unit.kind === 'group' ? receipt.unit.firstGroup : null,
          lastGroup: receipt.unit.kind === 'group' ? receipt.unit.lastGroup : null,
        })
      if (outcome === 'load-blocked') {
        await store.writeBlocks(runId, 'load', unitId, loadBlocks)
        return
      }
      for (const [ordinal, disposition] of output.dispositions.entries()) {
        const sourcePhase = disposition.sourcePhase ?? 'current'
        await insert('migration_row_dispositions', {
          runId,
          sourceTable: disposition.sourceTable,
          sourcePhase,
          sourceKey: disposition.sourceKey,
          ordinal,
          unitId,
          class: disposition.class,
          kind: disposition.kind,
          ruleId: disposition.rule.id,
          ruleVersion: disposition.rule.version,
          targetsJson: disposition.targets,
          archiveRef: disposition.archive,
          decisionJson: disposition.decision,
          historyJson: disposition.history ?? null,
          codecColumnsJson: disposition.codecColumns ?? null,
          allocationJson: disposition.allocation ?? null,
        })
        if (disposition.history) {
          const history = disposition.history
          await insert('migration_history_restrictions', {
            taskId: history.taskId,
            sourceTable: disposition.sourceTable,
            sourcePhase,
            sourceKey: disposition.sourceKey,
            runId,
            ordinal,
            nodeRunId: history.runId,
            execution: history.execution,
            executionUse: history.executionUse ?? null,
            reason: history.reason ?? null,
            missingFieldsJson: history.missingFields,
            decisionCode: disposition.decision?.code ?? disposition.kind,
            unitId,
          })
        }
      }
      for (const [ordinal, artifact] of output.artifacts.entries())
        await insert('migration_artifact_receipts', {
          runId,
          sourceTable: artifact.sourceTable,
          sourceKey: artifact.sourceKey,
          sourceColumn: artifact.sourceColumn,
          ordinal,
          unitId,
          originalReference: artifact.originalReference,
          targetTable: artifact.target.table,
          targetKey: artifact.target.key,
          contentId: artifact.target.contentId,
          backend: artifact.target.backend,
          sha256: artifact.bytes?.sha256 ?? null,
          size: artifact.bytes?.size ?? null,
          publication: artifact.publication,
          missingState: artifact.missing?.state ?? null,
          missingEvidence: artifact.missing?.evidence ?? null,
        })
      for (const archive of output.archives) {
        const previous = await store.archive({ runId, ref: archive.ref })
        if (previous) {
          if (
            !Buffer.from(previous.bytes).equals(Buffer.from(archive.bytes)) ||
            previous.kind !== archive.kind ||
            previous.sourceTable !== archive.sourceTable ||
            previous.rows !== archive.rows ||
            previous.format !== archive.format
          )
            throw new Error('v3-archive-conflict')
        } else
          await insert('migration_archives', {
            runId,
            archiveRef: archive.ref,
            unitId,
            kind: archive.kind,
            sourceTable: archive.sourceTable,
            format: archive.format,
            rows: archive.rows,
            byteSize: archive.bytes.byteLength,
            bytes: archive.bytes,
          })
      }
      for (const [ordinal, record] of output.records.entries())
        await insert('migration_records', {
          runId,
          unitId,
          ordinal,
          kind: record.kind,
          tableName: 'table' in record ? record.table : null,
          recordJson: record,
          recordDigest: valueDigest(record),
        })
      await store.writeBlocks(runId, 'unit', unitId, output.blocks)
    },
    async finishRun(runId, summary, now) {
      const run = await store.migrationRun(runId)
      if (!run) throw new Error('v3-sink-not-open')
      const digest = valueDigest(summary)
      if (run.summaryDigest) {
        if (run.summaryDigest !== digest) throw new Error('v3-sink-summary-conflict')
        return
      }
      if (
        valueDigest(summary.plan) !== valueDigest(run.conversionPlan) ||
        summary.stagingDigest !== run.binding.stagingDigest
      )
        throw new Error('v3-run-binding-mismatch')
      for (const receipt of summary.tableReceipts)
        await insert('migration_table_receipts', {
          runId,
          sourceTable: receipt.sourceTable,
          sourcePhase: receipt.sourcePhase,
          sourceVersion: receipt.sourceVersion,
          rowsRead: receipt.rowsRead,
          targetsJson: receipt.targets,
          countsJson: receipt.counts,
          exceptions: receipt.exceptions,
          historyOnly: receipt.historyOnly,
          keyDigest: receipt.keyDigest,
          contentDigest: receipt.contentDigest,
          units: receipt.units,
          activeClaimsJson: receipt.activeClaims,
        })
      const existingBlocks = await store.blocks({ runId })
      const unitBlocks = new Set(
        existingBlocks.filter((row) => row.origin === 'unit').map((row) => valueDigest(row.block)),
      )
      await store.writeBlocks(
        runId,
        'plan',
        null,
        summary.blocks.filter((block) => !unitBlocks.has(valueDigest(block))),
      )
      const persisted = new Set((await collectMigrationRows(store.records(runId))).map(valueDigest))
      for (const [ordinal, record] of summary.records
        .filter((record) => !persisted.has(valueDigest(record)))
        .entries())
        await insert('migration_records', {
          runId,
          unitId: '',
          ordinal,
          kind: record.kind,
          tableName: 'table' in record ? record.table : null,
          recordJson: record,
          recordDigest: valueDigest(record),
        })
      await store.saveIdentity(runId, foldIdentityHighWater(summary.records), null)
      const blocked =
        summary.status !== 'converted' ||
        summary.blocks.length > 0 ||
        existingBlocks.length > 0 ||
        summary.plan.coverage !== 'complete'
      await update(
        'migration_runs',
        { runId },
        { state: blocked ? 'blocked' : 'converted', summaryDigest: digest, convertedAt: now },
      )
    },
    async saveValidation(report) {
      const run = await store.migrationRun(report.runId)
      if (!run?.summaryDigest) throw new Error('v3-validation-before-finish')
      const { digest, ...payload } = report
      if (
        valueDigest(payload) !== digest ||
        report.passed !==
          (report.checks.length === VALIDATION_CHECKS.length &&
            VALIDATION_CHECKS.every(
              (check) =>
                report.checks.filter((entry) => entry.check === check && entry.passed).length === 1,
            ) &&
            report.blocks.length === 0 &&
            report.contentDrift.length === 0)
      )
        throw new Error('v3-validation-digest-mismatch')
      if (run.validationDigest === digest) return
      if (run.receiptExportDigest || run.state === 'activated' || run.state === 'retired')
        throw new Error('v3-validation-frozen')
      await update(
        'migration_runs',
        { runId: report.runId },
        {
          state: report.passed ? 'validated' : 'blocked',
          validationJson: report,
          validationDigest: report.digest,
          validatedAt: report.validatedAt,
        },
      )
      await tx.execute(
        `DELETE FROM ${metaTableName(tx.provider, 'migration_blocks')} WHERE run_id = ${parameters(tx, 1)} AND origin = 'validation'`,
        [report.runId],
      )
      await store.writeBlocks(report.runId, 'validation', null, report.blocks)
    },
    async saveIdentity(runId, values, appliedAt) {
      for (const entry of values) {
        const key = { runId, tableName: entry.table, columnName: entry.column }
        const row = {
          value: entry.value,
          basis: entry.basis,
          warningsJson: entry.warnings,
          appliedAt,
        }
        if ((await select('migration_identity_high_water', key)).length)
          await update('migration_identity_high_water', key, row)
        else await insert('migration_identity_high_water', { ...key, ...row })
      }
    },
    async saveExport(runId, value) {
      const existing = await store.receiptExport(runId)
      if (existing) {
        if (
          existing.digest !== value.digest ||
          !existing.bytes ||
          !Buffer.from(existing.bytes).equals(Buffer.from(value.bytes))
        )
          throw new Error('v3-receipt-export-conflict')
        return
      }
      await insert('migration_receipt_exports', { runId, ...value })
      await update('migration_runs', { runId }, { receiptExportDigest: value.digest })
    },
  }
  return store
}
