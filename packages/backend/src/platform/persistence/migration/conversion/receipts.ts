import { canonicalSchemaJson } from '../../schema/canonical'
import type { ConversionRule, RuleOutput } from './rule'
import type { TargetRegistryView } from './targetRows'
import { createTargetRow, createUnitUniqueChecker, TargetRowError } from './targetRows'
import { BLOCK_CODES, ConversionContractError, rowBlock } from './blockCodes'
import { bytesDigest, orderedDigest, targetRowJson, unorderedDigest, valueDigest } from './digest'
import { canonicalValue, decodeMigrationKey } from './migrationKey'
import { legacyEvidenceRow } from './evidence'
import { encodeStagedValue } from './staging'
import { HISTORY_EXECUTION_UNUSED_REASONS, RESOLUTION_CODES } from './types'
import type {
  ArchivePayload,
  ArchiveRef,
  ArtifactReceipt,
  ConversionBlock,
  ConversionResolution,
  DispositionClass,
  EncodedKey,
  JsonValue,
  LoadRejectionDecision,
  MigrationRecord,
  RowDisposition,
  SourceRow,
  TargetRef,
  TargetRow,
  TargetValue,
  UnitOutput,
  UnitRef,
  LookupVersion,
  DispositionCounts,
} from './types'

/**
 * RFC-626: unit outputs this process collected itself. Their receipt digest was computed from
 * the very object a sink receives, so a sink need not serialise the whole output a second time
 * to check it (that second pass was 38 s on a 1 GB database). Outputs from anywhere else are
 * still verified.
 */
const collected = new WeakSet<object>()
export function isCollectedUnitOutput(output: UnitOutput): boolean {
  return collected.has(output)
}
/** Blocks that say a rule broke its own contract; automatic resolution never hides them. */
const RULE_CONTRACT_BLOCKS: readonly string[] = [
  BLOCK_CODES.unclassifiedRow,
  BLOCK_CODES.missingDisposition,
]

export function emptyCounts(): Record<DispositionClass, number> {
  return { converted: 0, preserved: 0, archived: 0, blocked: 0 }
}
export function addCounts(to: Record<DispositionClass, number>, from: DispositionCounts): void {
  for (const key of Object.keys(to) as DispositionClass[]) to[key] += from[key]
}
export interface UnitCollector {
  readonly out: RuleOutput
  /** True for a row that takes no part in the conversion: blocked, or set aside (RFC-626). */
  blocked(row: SourceRow): boolean
  links(row: SourceRow): readonly TargetRef[]
  /**
   * RFC-626: the source row a target row of this unit was produced from; null for a row the
   * rule produced from nothing, undefined when this unit has no such target row.
   */
  originOfTarget(table: string, key: EncodedKey): SourceRow | null | undefined
  /** RFC-626: tasks that discovery has to end because of this unit, with the block code. */
  settlementTriggers(): readonly { readonly taskId: string; readonly code: string }[]
  /**
   * RFC-626: an `ExecutableValidatorBlock` of a validator of this unit. `declared` says whether
   * that validator declares `settles`; the rule's own declaration does not cover it.
   */
  validatorBlockExecutable(
    declared: boolean,
    task: { readonly taskId: string; readonly status: string },
    block: ConversionBlock,
  ): void
  finish(input: {
    readonly unit: UnitRef
    readonly unitId: string
    readonly lookups: readonly LookupVersion[]
  }): UnitOutput
}
/**
 * The value a target row was refused for, as block detail. `canonicalValue` has no form for a
 * number that is not finite (a rule can compute one from JSON text), and reporting the refusal
 * must not fail on the value it reports.
 */
function rejectedValue(value: TargetValue): JsonValue {
  return typeof value === 'number' && !Number.isFinite(value)
    ? { type: 'real', value: String(value) }
    : (canonicalValue(value) as unknown as JsonValue)
}
export function createUnitCollector(input: {
  readonly rule: ConversionRule
  readonly sourceRows: readonly SourceRow[]
  readonly sourceVersion: string
  readonly sourceContract: string
  readonly target: TargetRegistryView
  readonly topology: readonly string[]
  /** RFC-626: default `operator`, the behaviour before automatic resolution existed. */
  readonly resolution?: ConversionResolution
  /** RFC-626: `discover` finds the tasks to end; nothing it collects is committed. */
  readonly mode?: 'convert' | 'discover'
  /**
   * RFC-626: present when the rule (or a validator of this unit) declares `settles`: the tasks
   * a row belongs to, and whether a task is still unfinished after the settlements applied so far.
   */
  readonly settles?: {
    tasksOf(row: SourceRow): readonly string[] | undefined
    isExecutable(taskId: string): boolean
  }
  /** RFC-626: a source row the target cannot do without; it is never set aside. */
  readonly requiredSeed?: (row: SourceRow) => boolean
  /** RFC-626: rows already known to be refused by the target; set aside before anything runs. */
  readonly loadRejections?: readonly LoadRejectionDecision[]
}): UnitCollector {
  const { rule, target, sourceRows } = input
  const automatic = input.resolution === 'automatic'
  const discovering = input.mode === 'discover'
  const origins = new Map<string, SourceRow>(sourceRows.map((row) => [row.encodedKey, row]))
  const classified = new Map<string, DispositionClass>()
  const links = new Map<string, TargetRef[]>()
  const exceptions: RowDisposition[] = []
  const blocks: ConversionBlock[] = []
  const artifacts: ArtifactReceipt[] = []
  const archives: (ArchivePayload & { ref: ArchiveRef })[] = []
  const records: MigrationRecord[] = []
  /** The source row a record was written for, when the rule named one (`record(record, row)`). */
  const recordOrigins = new Map<MigrationRecord, string>()
  const targetRows = new Map<string, { row: TargetRow; originKey: string | null }[]>()
  const codecDecisions = new Map<string, Set<string>>()
  const setAside = new Map<string, string>()
  const triggers: { taskId: string; code: string }[] = []
  const excluded = (key: string): boolean => classified.get(key) === 'blocked' || setAside.has(key)
  const unique = createUnitUniqueChecker(target)
  const requireOrigin = (key: string): SourceRow => {
    const row = origins.get(key)
    if (!row) throw new ConversionContractError('v2-foreign-disposition', key)
    return row
  }
  const classOf = (row: SourceRow): DispositionClass =>
    rule.preservedClaims?.includes(row.table) ? 'preserved' : (rule.disposition ?? 'converted')
  const mark = (row: SourceRow, disposition: DispositionClass): void => {
    requireOrigin(row.encodedKey)
    if (!excluded(row.encodedKey)) classified.set(row.encodedKey, disposition)
  }
  /**
   * Rows of a `preservedClaims` table that an exception has given another class: the rule
   * changed such a row, so it is no longer "kept as it was". A target row or a record written
   * for it afterwards must not put the table's default back, or the table receipt would count
   * the row as preserved while its row disposition says converted. Rows of every other table
   * take the rule's class from `row` and `record` as they always did.
   */
  const reclassified = new Set<string>()
  const markDefault = (row: SourceRow): void => {
    if (!reclassified.has(row.encodedKey)) mark(row, classOf(row))
  }
  const endTasksOf = (row: SourceRow, code: string): void => {
    for (const taskId of input.settles?.tasksOf(row) ?? []) {
      if (!input.settles!.isExecutable(taskId)) continue
      if (discovering) triggers.push({ taskId, code })
      // The settlements were fixed before the target was opened: a row of an unfinished task
      // that is set aside now means discovery did not see what the conversion sees.
      else
        throw new ConversionContractError(RESOLUTION_CODES.settlementMissed, `${taskId}: ${code}`)
    }
  }
  /** RFC-626: the automatic counterpart of a row-level block. */
  const setRowAside = (row: SourceRow, code: string, detail: JsonValue): void => {
    if (setAside.has(row.encodedKey)) return
    if (input.requiredSeed?.(row))
      throw new ConversionContractError(
        RESOLUTION_CODES.requiredSeedSetAside,
        `${row.table}/${row.encodedKey}: ${code}`,
      )
    endTasksOf(row, code)
    setAside.set(row.encodedKey, code)
    classified.set(row.encodedKey, 'archived')
    const archive = out.archive({
      kind: 'source-journal',
      sourceTable: row.table,
      format: 'logical-row@1',
      bytes: new TextEncoder().encode(
        canonicalSchemaJson({ canonical: row.canonical, raw: row.raw ?? null }),
      ),
      rows: 1,
    })
    exceptions.push({
      sourceTable: row.table,
      sourceKey: row.encodedKey,
      sourcePhase: row.phase,
      class: 'archived',
      kind: 'archived',
      targets: [],
      archive,
      rule: rule.ref,
      decision: { code, detail },
    })
    records.push({
      kind: 'decision',
      code: RESOLUTION_CODES.rowSetAside,
      payload: {
        automatic: 'set-aside',
        sourcePhase: row.phase,
        sourceTable: row.table,
        sourceKey: row.encodedKey,
        code,
      },
    })
  }
  /** "This task could continue, so the row blocks", from the rule or from one of its validators. */
  const endExecutable = (
    declared: boolean,
    task: { readonly taskId: string; readonly status: string },
    block: ConversionBlock,
  ): void => {
    if (!declared || !input.settles)
      throw new ConversionContractError(
        'v2-settles-undeclared',
        `${rule.ref.id}: blockExecutable needs a settles declaration`,
      )
    if (!automatic) {
      out.block(block)
      return
    }
    if (!discovering)
      throw new ConversionContractError(
        RESOLUTION_CODES.settlementMissed,
        `${task.taskId}: ${block.code}`,
      )
    triggers.push({ taskId: task.taskId, code: block.code })
    // Discovery output is discarded; keep the row out of the rest of this unit as a block would.
    if (block.scope === 'row' && block.sourceKey !== null)
      classified.set(requireOrigin(block.sourceKey).encodedKey, 'blocked')
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
          markDefault(origin)
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
                value: error.value === undefined ? null : rejectedValue(error.value),
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
      if (rule.preservedClaims?.includes(row.table) && disposition.class !== classOf(row))
        reclassified.add(row.encodedKey)
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
      if (
        automatic &&
        block.scope === 'row' &&
        block.sourceKey !== null &&
        !RULE_CONTRACT_BLOCKS.includes(block.code)
      ) {
        setRowAside(requireOrigin(block.sourceKey), block.code, block.detail)
        return
      }
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
    blockExecutable(task, block) {
      // The declaration is the caller's own: a validator of the same unit that declares
      // `settles` does not make an undeclared rule's call legitimate, and the other way round.
      endExecutable(Boolean(rule.settles), task, block)
    },
    record(record, origin) {
      records.push(record)
      if (origin) {
        markDefault(origin)
        recordOrigins.set(record, origin.encodedKey)
      }
    },
  }
  // RFC-626: several rules wrap their conversion in a catch-all that reports whatever was
  // thrown as a block on the row. With automatic resolution a row-level block sets the row
  // aside, so a contract error swallowed there would turn an engine fault into a quietly
  // archived row. The first contract error is therefore remembered and ends the unit in
  // `finish`, whatever the rule did with it. Operator resolution keeps the old behaviour.
  let fault: ConversionContractError | undefined
  if (automatic)
    for (const name of Object.keys(out) as (keyof RuleOutput)[]) {
      const method = out[name] as (...args: never[]) => unknown
      ;(out as unknown as Record<string, unknown>)[name] = (...args: never[]) => {
        try {
          return method(...args)
        } catch (error) {
          if (error instanceof ConversionContractError) fault ??= error
          throw error
        }
      }
    }
  // Known refusals first: the unit then converts exactly as it did when it was committed.
  for (const decision of input.loadRejections ?? []) {
    const row = requireOrigin(decision.sourceKey)
    if (row.table !== decision.sourceTable || row.phase !== decision.sourcePhase)
      throw new ConversionContractError('v2-foreign-disposition', decision.sourceKey)
    setRowAside(row, RESOLUTION_CODES.loadRejected, decision as unknown as JsonValue)
  }
  return {
    out,
    blocked: (row) => excluded(row.encodedKey),
    links: (row) => links.get(row.encodedKey) ?? [],
    originOfTarget(table, key) {
      const produced = targetRows.get(table)?.find((entry) => target.key(table, entry.row) === key)
      if (!produced) return undefined
      return produced.originKey === null ? null : (origins.get(produced.originKey) ?? null)
    },
    settlementTriggers: () => triggers,
    validatorBlockExecutable(declared, task, block) {
      try {
        endExecutable(declared, task, block)
      } catch (error) {
        if (automatic && error instanceof ConversionContractError) fault ??= error
        throw error
      }
    },
    finish({ unit, unitId, lookups }) {
      if (fault) throw fault
      for (const row of sourceRows) {
        const undecided = (row.codecTakeovers ?? []).filter(
          (failure) => !codecDecisions.get(row.encodedKey)?.has(failure.column),
        )
        if (undecided.length && !excluded(row.encodedKey))
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
          !excluded(row.encodedKey) &&
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
      for (const row of sourceRows) if (excluded(row.encodedKey)) links.delete(row.encodedKey)
      // RFC-626: a row of a task the upgrade ended says so in the unit that consumed it.
      for (const row of sourceRows)
        if (row.settlement)
          records.push({
            kind: 'decision',
            code: RESOLUTION_CODES.taskSettled,
            payload: {
              automatic: 'settled',
              sourcePhase: row.phase,
              sourceTable: row.table,
              sourceKey: row.encodedKey,
              taskId: row.settlement.taskId,
              cause: row.settlement.cause,
              columns: row.settlement.columns as unknown as JsonValue,
            },
          })
      // A row set aside was not converted: only its archived disposition describes it. The
      // receipt counts the dispositions the unit hands over, not those it dropped (RFC-626).
      const dispositions = exceptions.filter(
        (disposition) => !setAside.has(disposition.sourceKey) || disposition.kind === 'archived',
      )
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
          exceptions: dispositions.filter((item) => item.sourceTable === table).length,
          historyOnly: new Set(
            dispositions
              .filter((item) => item.sourceTable === table && item.kind === 'history-only')
              .map((item) => item.sourceKey),
          ).size,
        }
      })
      // Each row is serialised once: the same text orders the rows and feeds the table digest.
      const sortedTargets = input.topology
        .filter((table) => targetRows.has(table))
        .map((table) => ({
          table,
          rows: targetRows
            .get(table)!
            .filter(({ originKey }) => originKey === null || !excluded(originKey))
            .map(({ row }) => ({ row, json: targetRowJson(row) }))
            .sort((a, b) => (a.json < b.json ? -1 : a.json > b.json ? 1 : 0)),
        }))
        .filter(({ rows }) => rows.length > 0)
      const rows = sortedTargets.map(({ table, rows }) => ({
        table,
        rows: rows.map(({ row }) => row),
      }))
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
        // `orderedDigest` of the sorted texts is `targetRowsDigest`, without sorting again.
        targets: sortedTargets.map(({ table, rows }) => ({
          table,
          rows: rows.length,
          digest: orderedDigest(rows.map(({ json }) => json)),
        })),
        counts: {
          ...counts,
          exceptions: dispositions.length,
          historyOnly: sources.reduce((sum, source) => sum + source.historyOnly, 0),
        },
      }
      const ordered = <T>(values: readonly T[]): T[] =>
        values
          .map((value) => ({ value, text: encodeStagedValue(value) }))
          .sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
          .map(({ value }) => value)
      /**
       * RFC-626: what a record says about a row the unit then set aside no longer holds. A
       * "kept with a marker" decision and an active claim describe a row that is not in the
       * target; the row's own `v2-row-set-aside` decision is what describes it. The row a record
       * is about is the one its payload names, else the one the rule wrote it for.
       */
      const describesSetAsideRow = (record: MigrationRecord): boolean => {
        if (record.kind !== 'decision' && record.kind !== 'source-metadata') return false
        const payload = record.payload
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
        const fields = payload as { readonly [key: string]: JsonValue }
        if (
          record.kind === 'decision' ? fields.automatic !== 'kept' : fields.kind !== 'active-claim'
        )
          return false
        const key =
          typeof fields.sourceKey === 'string' ? fields.sourceKey : recordOrigins.get(record)
        return key !== undefined && setAside.has(key)
      }
      const output = {
        rows,
        dispositions: ordered(
          dispositions.map((disposition) => ({
            ...disposition,
            targets: excluded(disposition.sourceKey) ? [] : ordered(disposition.targets),
          })),
        ),
        // A row set aside is not in the target; a receipt for its content would describe a
        // row nobody can find. Blocked rows keep theirs, as they always did.
        artifacts: ordered(artifacts.filter((receipt) => !setAside.has(receipt.sourceKey))),
        archives: ordered(archives),
        blocks: ordered(blocks),
        records: ordered(records.filter((record) => !describesSetAsideRow(record))),
      }
      const unitOutput: UnitOutput = {
        ...output,
        receipt: {
          ...receipt,
          digest: valueDigest({ receipt, output: encodeStagedValue(output) }),
        },
      }
      collected.add(unitOutput)
      return unitOutput
    },
  }
}
