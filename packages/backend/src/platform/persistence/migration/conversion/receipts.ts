import { canonicalSchemaJson } from '../../schema/canonical'
import type { ConversionRule, RuleOutput } from './rule'
import type { TargetRegistryView } from './targetRows'
import { createTargetRow, createUnitUniqueChecker, TargetRowError } from './targetRows'
import { BLOCK_CODES, ConversionContractError, rowBlock } from './blockCodes'
import {
  bytesDigest,
  targetRowJson,
  targetRowsDigest,
  unorderedDigest,
  valueDigest,
} from './digest'
import { canonicalValue, decodeMigrationKey } from './migrationKey'
import { legacyEvidenceRow } from './evidence'
import { encodeStagedValue } from './staging'
import { HISTORY_EXECUTION_UNUSED_REASONS } from './types'
import type {
  ArchivePayload,
  ArchiveRef,
  ArtifactReceipt,
  ConversionBlock,
  DispositionClass,
  MigrationRecord,
  RowDisposition,
  SourceRow,
  TargetRef,
  TargetRow,
  UnitOutput,
  UnitRef,
  LookupVersion,
  DispositionCounts,
} from './types'

export function emptyCounts(): Record<DispositionClass, number> {
  return { converted: 0, preserved: 0, archived: 0, blocked: 0 }
}
export function addCounts(to: Record<DispositionClass, number>, from: DispositionCounts): void {
  for (const key of Object.keys(to) as DispositionClass[]) to[key] += from[key]
}
export interface UnitCollector {
  readonly out: RuleOutput
  blocked(row: SourceRow): boolean
  links(row: SourceRow): readonly TargetRef[]
  finish(input: {
    readonly unit: UnitRef
    readonly unitId: string
    readonly lookups: readonly LookupVersion[]
  }): UnitOutput
}
export function createUnitCollector(input: {
  readonly rule: ConversionRule
  readonly sourceRows: readonly SourceRow[]
  readonly sourceVersion: string
  readonly sourceContract: string
  readonly target: TargetRegistryView
  readonly topology: readonly string[]
}): UnitCollector {
  const { rule, target, sourceRows } = input
  const origins = new Map<string, SourceRow>(sourceRows.map((row) => [row.encodedKey, row]))
  const classified = new Map<string, DispositionClass>()
  const links = new Map<string, TargetRef[]>()
  const exceptions: RowDisposition[] = []
  const blocks: ConversionBlock[] = []
  const artifacts: ArtifactReceipt[] = []
  const archives: (ArchivePayload & { ref: ArchiveRef })[] = []
  const records: MigrationRecord[] = []
  const targetRows = new Map<string, { row: TargetRow; originKey: string | null }[]>()
  const codecDecisions = new Map<string, Set<string>>()
  const unique = createUnitUniqueChecker(target)
  const requireOrigin = (key: string): SourceRow => {
    const row = origins.get(key)
    if (!row) throw new ConversionContractError('v2-foreign-disposition', key)
    return row
  }
  const mark = (row: SourceRow, disposition: DispositionClass): void => {
    requireOrigin(row.encodedKey)
    if (classified.get(row.encodedKey) !== 'blocked') classified.set(row.encodedKey, disposition)
  }
  const out: RuleOutput = {
    row(table, values, origin) {
      const declaration = rule.produces.find((output) => output.table === table)
      if (!declaration)
        throw new ConversionContractError('v2-undeclared-target', `${rule.ref.id}/${table}`)
      if (origin) requireOrigin(origin.encodedKey)
      if (
        declaration.partition &&
        !declaration.partition.split('|').includes(String(values.record_kind))
      )
        throw new ConversionContractError(
          'v2-target-partition',
          `${table}/${String(values.record_kind)}`,
        )
      try {
        const row = createTargetRow(target, table, values)
        unique(table, row)
        const rows = targetRows.get(table) ?? []
        rows.push({ row, originKey: origin?.encodedKey ?? null })
        targetRows.set(table, rows)
        if (origin) {
          mark(origin, rule.disposition ?? 'converted')
          const refs = links.get(origin.encodedKey) ?? []
          refs.push({ table, key: target.key(table, row) })
          links.set(origin.encodedKey, refs)
        }
      } catch (error) {
        if (!(error instanceof TargetRowError)) throw error
        if (origin)
          out.block(
            rowBlock(
              error.code,
              origin,
              {
                table: error.table,
                column: error.column,
                value: error.value === undefined ? null : canonicalValue(error.value),
                message: error.message,
              },
              error.column ? [error.column] : [],
            ),
          )
        else
          out.block({
            code: error.code,
            scope: 'global',
            sourceTable: null,
            sourceKey: null,
            taskId: null,
            runId: null,
            missingFields: error.column ? [error.column] : [],
            detail: { table, message: error.message },
          })
      }
    },
    exception(disposition) {
      const row = requireOrigin(disposition.sourceKey)
      if (
        row.table !== disposition.sourceTable ||
        (disposition.sourcePhase ?? row.phase) !== row.phase
      )
        throw new ConversionContractError('v2-foreign-disposition', disposition.sourceKey)
      if (
        ![
          'derived-id',
          'merged',
          'deleted-placeholder',
          'history-only',
          'archived',
          'blocked',
          'conflict-resolved',
        ].includes(disposition.kind)
      )
        throw new ConversionContractError(
          'v2-same-key-disposition',
          'same-key derivations belong only in chunk receipts',
        )
      for (const ref of disposition.targets) {
        if (
          decodeMigrationKey(ref.key).table !== ref.table ||
          !rule.produces.some((output) => output.table === ref.table)
        )
          throw new ConversionContractError('v2-undeclared-disposition-target', ref.table)
      }
      if (disposition.kind === 'history-only') {
        const history = disposition.history
        const unused =
          history?.execution === 'executable' &&
          history.executionUse === 'none' &&
          HISTORY_EXECUTION_UNUSED_REASONS.some((reason) => reason === history.reason)
        const historical =
          history &&
          ['retryable-history', 'terminal-history'].includes(history.execution) &&
          history.executionUse === undefined &&
          history.reason === undefined
        if (!unused && !historical)
          throw new ConversionContractError('v2-history-restriction', row.encodedKey)
      }
      if (disposition.kind === 'derived-id') {
        const sourceKey = canonicalSchemaJson(row.key)
        const allocation = disposition.allocation
        const allocated =
          allocation &&
          /^-?(0|[1-9][0-9]*)$/.test(allocation.value) &&
          /^-?(0|[1-9][0-9]*)$/.test(allocation.sourceHighWater) &&
          BigInt(allocation.value) > BigInt(allocation.sourceHighWater)
        const minted = disposition.targets.some((ref) => {
          const key = decodeMigrationKey(ref.key).key
          return (
            canonicalSchemaJson(key) !== sourceKey &&
            key.some(
              (cell) =>
                (cell.type === 'text' && cell.value.startsWith('mc1_')) ||
                (allocated && cell.type === 'integer' && cell.value === allocation.value),
            )
          )
        })
        if (!minted) throw new ConversionContractError('v2-same-key-disposition', row.encodedKey)
      }
      if ((disposition.kind === 'archived') !== (disposition.class === 'archived'))
        throw new ConversionContractError('v2-disposition-class', row.encodedKey)
      if (disposition.kind !== 'blocked' && disposition.decision === null)
        throw new ConversionContractError('v2-disposition-decision', row.encodedKey)
      if (
        disposition.kind === 'archived' &&
        (!disposition.archive || !archives.some((archive) => archive.ref === disposition.archive))
      )
        throw new ConversionContractError('v2-archive-disposition', row.encodedKey)
      if ((disposition.class === 'blocked') !== (disposition.kind === 'blocked'))
        throw new ConversionContractError('v2-disposition-class', row.encodedKey)
      if (disposition.codecColumns) {
        const columns = disposition.codecColumns
        if (
          disposition.class !== 'converted' ||
          !disposition.decision?.code.trim() ||
          !columns.length ||
          new Set(columns).size !== columns.length ||
          columns.some(
            (column) =>
              !row.codecTakeovers?.some((failure) => failure.column === column) ||
              !rule.codecTakeovers?.some(
                (entry) => entry.table === row.table && entry.columns.includes(column),
              ),
          )
        )
          throw new ConversionContractError('v2-codec-decision', row.encodedKey)
        const decided = codecDecisions.get(row.encodedKey) ?? new Set<string>()
        for (const column of columns) decided.add(column)
        codecDecisions.set(row.encodedKey, decided)
      }
      mark(row, disposition.class)
      exceptions.push({ ...disposition, sourcePhase: row.phase, rule: rule.ref })
      if (disposition.kind === 'blocked')
        out.block(
          rowBlock(
            disposition.decision?.code ?? BLOCK_CODES.rowBlocked,
            row,
            disposition.decision?.detail ?? null,
          ),
        )
    },
    evidence(evidence) {
      out.row(
        'execution_legacy_evidence',
        legacyEvidenceRow(evidence, input.sourceContract),
        evidence.origin,
      )
    },
    artifact(receipt) {
      requireOrigin(receipt.sourceKey)
      artifacts.push(structuredClone(receipt))
    },
    archive(payload) {
      const ref: ArchiveRef = `archive:${bytesDigest(payload.bytes)}` as ArchiveRef
      archives.push({ ...payload, bytes: Uint8Array.from(payload.bytes), ref })
      return ref
    },
    block(block) {
      blocks.push(block)
      const rows =
        block.scope === 'row'
          ? [requireOrigin(block.sourceKey ?? '')]
          : block.scope === 'table'
            ? sourceRows.filter((row) => row.table === block.sourceTable)
            : []
      for (const row of rows) {
        classified.set(row.encodedKey, 'blocked')
        if (
          !exceptions.some(
            (disposition) =>
              disposition.sourceKey === row.encodedKey && disposition.kind === 'blocked',
          )
        )
          exceptions.push({
            sourceTable: row.table,
            sourceKey: row.encodedKey,
            sourcePhase: row.phase,
            class: 'blocked',
            kind: 'blocked',
            targets: links.get(row.encodedKey) ?? [],
            archive: null,
            rule: rule.ref,
            decision: { code: block.code, detail: block.detail },
          })
      }
    },
    record(record, origin) {
      records.push(record)
      if (origin) mark(origin, rule.disposition ?? 'converted')
    },
  }
  return {
    out,
    blocked: (row) => classified.get(row.encodedKey) === 'blocked',
    links: (row) => links.get(row.encodedKey) ?? [],
    finish({ unit, unitId, lookups }) {
      for (const row of sourceRows) {
        const undecided = (row.codecTakeovers ?? []).filter(
          (failure) => !codecDecisions.get(row.encodedKey)?.has(failure.column),
        )
        if (undecided.length && classified.get(row.encodedKey) !== 'blocked')
          out.block(
            rowBlock(
              BLOCK_CODES.undecidedSourceCodec,
              row,
              { rule: rule.ref.id },
              undecided.map((failure) => failure.column),
            ),
          )
        const minted = (links.get(row.encodedKey) ?? []).some((ref) =>
          decodeMigrationKey(ref.key).key.some(
            (cell) =>
              cell.type === 'text' &&
              cell.value.startsWith('mc1_') &&
              !row.key.some((source) => source.type === 'text' && source.value === cell.value),
          ),
        )
        if (
          minted &&
          classified.get(row.encodedKey) !== 'blocked' &&
          !exceptions.some(
            (disposition) =>
              disposition.sourceKey === row.encodedKey &&
              ['derived-id', 'merged', 'conflict-resolved', 'history-only'].includes(
                disposition.kind,
              ),
          )
        )
          out.block(rowBlock(BLOCK_CODES.missingDisposition, row, { rule: rule.ref.id }))
      }
      for (const row of sourceRows)
        if (!classified.has(row.encodedKey))
          out.block(rowBlock(BLOCK_CODES.unclassifiedRow, row, { rule: rule.ref.id }))
      for (const row of sourceRows)
        if (classified.get(row.encodedKey) === 'blocked') links.delete(row.encodedKey)
      const sources = rule.claims.map((table) => {
        const rows = sourceRows
          .filter((row) => row.table === table)
          .sort((a, b) => Buffer.compare(Buffer.from(a.encodedKey), Buffer.from(b.encodedKey)))
        const counts = emptyCounts()
        for (const row of rows) counts[classified.get(row.encodedKey)!]++
        return {
          table,
          phase: rule.sourcePhase ?? ('current' as const),
          rows: rows.length,
          digest: unorderedDigest(
            rows.map((row) =>
              canonicalSchemaJson({ canonical: row.canonical, raw: row.raw ?? null }),
            ),
          ),
          keyDigest: unorderedDigest(rows.map((row) => row.encodedKey)),
          firstKey: rows[0]?.encodedKey ?? null,
          lastKey: rows.at(-1)?.encodedKey ?? null,
          counts,
          exceptions: exceptions.filter((item) => item.sourceTable === table).length,
          historyOnly: new Set(
            exceptions
              .filter((item) => item.sourceTable === table && item.kind === 'history-only')
              .map((item) => item.sourceKey),
          ).size,
        }
      })
      const rows = input.topology
        .filter((table) => targetRows.has(table))
        .map((table) => ({
          table,
          rows: targetRows
            .get(table)!
            .filter(
              ({ originKey }) => originKey === null || classified.get(originKey) !== 'blocked',
            )
            .map(({ row }) => row)
            .sort((a, b) =>
              targetRowJson(a) < targetRowJson(b)
                ? -1
                : targetRowJson(a) > targetRowJson(b)
                  ? 1
                  : 0,
            ),
        }))
        .filter(({ rows }) => rows.length > 0)
      const counts = emptyCounts()
      for (const source of sources) addCounts(counts, source.counts)
      const receipt = {
        version: 1 as const,
        unitId,
        unit,
        sourceVersion: input.sourceVersion,
        rule: rule.ref,
        lookups,
        sources,
        targets: rows.map(({ table, rows }) => ({
          table,
          rows: rows.length,
          digest: targetRowsDigest(rows),
        })),
        counts: {
          ...counts,
          exceptions: exceptions.length,
          historyOnly: sources.reduce((sum, source) => sum + source.historyOnly, 0),
        },
      }
      const ordered = <T>(values: readonly T[]): T[] =>
        [...values].sort((a, b) =>
          encodeStagedValue(a) < encodeStagedValue(b)
            ? -1
            : encodeStagedValue(a) > encodeStagedValue(b)
              ? 1
              : 0,
        )
      const output = {
        rows,
        dispositions: ordered(
          exceptions.map((disposition) => ({
            ...disposition,
            targets:
              classified.get(disposition.sourceKey) === 'blocked'
                ? []
                : ordered(disposition.targets),
          })),
        ),
        artifacts: ordered(artifacts),
        archives: ordered(archives),
        blocks: ordered(blocks),
        records: ordered(records),
      }
      return {
        ...output,
        receipt: {
          ...receipt,
          digest: valueDigest({ receipt, output: encodeStagedValue(output) }),
        },
      }
    },
  }
}
