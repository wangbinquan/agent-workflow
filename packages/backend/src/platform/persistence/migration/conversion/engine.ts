import { canonicalSchemaJson } from '../../schema/canonical'
import {
  buildConversionPlan,
  resolveContributions,
  sourceIdentity,
  type ConversionInput,
} from './plan'
import { createStagingStore, type StagingStore } from './staging'
import {
  buildLookups,
  restrictLookups,
  lookupIdentity,
  type LookupKey,
  type LookupResolver,
} from './lookups'
import { stageSourceTable } from './readSource'
import { targetRegistryView } from './targetRows'
import { createUnitCollector, emptyCounts, addCounts } from './receipts'
import { deterministicChildId } from './ids'
import { bytesDigest, unorderedDigest, valueDigest } from './digest'
import { BLOCK_CODES, ConversionContractError, rowBlock } from './blockCodes'
import { operatorDecisionRowDigest } from './types'
import type { ConversionRule, ConversionUnit, RuleContext } from './rule'
import type { ConversionSink, ConversionSummary } from './sink'
import type {
  ConversionBlock,
  EncodedKey,
  RowDisposition,
  MigrationRecord,
  SourceRow,
  TableReceipt,
  UnitOutput,
  UnitRef,
  TargetRef,
  JsonValue,
} from './types'

interface PlannedUnit {
  readonly ref: UnitRef
  readonly unit: ConversionUnit
  readonly orphan?: boolean
}
function* ruleUnits(
  rule: ConversionRule,
  staged: StagingStore,
  resolve: LookupResolver,
  limit: number,
): Iterable<PlannedUnit> {
  const phase = rule.sourcePhase ?? 'current'
  const spec = rule.unit
  if (spec.kind !== 'group') {
    let afterKey: EncodedKey | null = null
    do {
      const rows = staged.read(spec.table, { phase, afterKey, limit })
      if (!rows.length && afterKey !== null) return
      yield {
        ref: { kind: spec.kind, table: spec.table, phase, afterKey, limit },
        unit: { rows: new Map([[spec.table, rows]]) },
      }
      if (rows.length < limit) return
      afterKey = rows.at(-1)!.encodedKey
    } while (true)
  }
  const groups =
    typeof spec.driver === 'string'
      ? staged.groupKeys(spec.driver, spec.groupColumn, phase)
      : [...resolve(spec.driver).entries()].map(([key]) => key).sort()
  const driverGroups = new Set(groups)
  const groupLimit = spec.groupsPerUnit ?? 1
  let index = 0
  for (let start = 0; start < groups.length || start === 0; start += groupLimit) {
    const keys = groups.slice(start, start + groupLimit)
    const rows = new Map<string, readonly SourceRow[]>()
    if (typeof spec.driver === 'string')
      rows.set(
        spec.driver,
        keys.flatMap((key) => staged.group(spec.driver as string, spec.groupColumn, key, phase)),
      )
    for (const member of spec.members)
      rows.set(
        member.table,
        keys.flatMap((key) => staged.group(member.table, member.column, key, phase)),
      )
    yield {
      ref: {
        kind: 'group',
        rule: rule.ref.id,
        index: index++,
        firstGroup: keys[0] ?? null,
        lastGroup: keys.at(-1) ?? null,
      },
      unit: { rows, groupKeys: keys },
    }
  }
  // Rows with a NULL/dangling group never silently disappear when the driver is a lookup.
  for (const member of spec.members) {
    let pending: SourceRow[] = []
    const orphanUnit = (rows: readonly SourceRow[]): PlannedUnit => ({
      orphan: true,
      ref: { kind: 'group', rule: rule.ref.id, index: index++, firstGroup: null, lastGroup: null },
      unit: {
        rows: new Map(rule.claims.map((table) => [table, table === member.table ? rows : []])),
        groupKeys: [],
      },
    })
    for (const row of staged.rows(member.table, phase))
      if (
        typeof row.values[member.column] !== 'string' ||
        !driverGroups.has(row.values[member.column] as string)
      ) {
        pending.push(row)
        if (pending.length === limit) {
          yield orphanUnit(pending)
          pending = []
        }
      }
    if (pending.length) yield orphanUnit(pending)
  }
}
export interface ConversionObserver {
  unit(
    output: UnitOutput,
    rows: readonly SourceRow[],
    links: (row: SourceRow) => readonly TargetRef[],
  ): void
}
export async function runConversion(
  input: ConversionInput,
  sink: ConversionSink,
): Promise<ConversionSummary> {
  return executeConversion(input, sink)
}
/** Trace observes exactly the same conversion, without a database writer. */
export async function executeConversion(
  input: ConversionInput,
  sink: ConversionSink,
  observer?: ConversionObserver,
): Promise<ConversionSummary> {
  input.progress?.({ phase: 'conversion', detail: 'start', boundary: true })
  let completedUnits = 0
  const resolved = resolveContributions(input)
  const plan = buildConversionPlan(input, resolved)
  const rules = resolved.rules.filter((rule) =>
    plan.tables.some((table) => table.rule === rule.ref.id),
  )
  const staged = createStagingStore(input.scratchRoot, input.progress)
  const assertSource = async (): Promise<void> => {
    await input.source.assertUnchanged(input.preflight)
    if (input.preUpgradeSource && input.preUpgradePreflight)
      await input.preUpgradeSource.assertUnchanged(input.preUpgradePreflight)
  }
  try {
    await assertSource()
    const needed = new Map<
      string,
      { table: string; phase: 'current' | 'pre-upgrade'; raw: boolean }
    >()
    for (const rule of rules)
      for (const table of rule.claims)
        needed.set(sourceIdentity(table, rule.sourcePhase), {
          table,
          phase: rule.sourcePhase ?? 'current',
          raw: rule.unit.kind === 'raw-chunk',
        })
    for (const lookup of resolved.lookups)
      for (const table of lookup.sources)
        if (!needed.has(sourceIdentity(table, lookup.sourcePhase)))
          needed.set(sourceIdentity(table, lookup.sourcePhase), {
            table,
            phase: lookup.sourcePhase ?? 'current',
            raw: false,
          })
    const blocks: ConversionBlock[] = [...plan.blocks]
    for (const entry of [...needed.values()].sort((a, b) =>
      sourceIdentity(a.table, a.phase).localeCompare(sourceIdentity(b.table, b.phase)),
    )) {
      const preflight = entry.phase === 'current' ? input.preflight : input.preUpgradePreflight!
      const source = entry.phase === 'current' ? input.source : input.preUpgradeSource!
      const declaration = preflight.tables.find((table) => table.table === entry.table)!
      if (declaration.disposition === 'blocked') continue
      const codecTakeovers = resolved.rules
        .filter((rule) => (rule.sourcePhase ?? 'current') === entry.phase)
        .flatMap((rule) => rule.codecTakeovers ?? [])
        .filter((takeover) => takeover.table === entry.table)
        .flatMap((takeover) => takeover.columns)
      await stageSourceTable({
        ...entry,
        source,
        preflight,
        limit: plan.chunkLimit,
        staged,
        codecTakeovers,
        progress: input.progress,
      })
      if (staged.count(entry.table, entry.phase) !== declaration.rows)
        blocks.push({
          code: BLOCK_CODES.sourceCensus,
          scope: 'table',
          sourceTable: entry.table,
          sourcePhase: entry.phase,
          sourceKey: null,
          taskId: null,
          runId: null,
          missingFields: [],
          detail: { expected: declaration.rows, actual: staged.count(entry.table, entry.phase) },
        })
    }
    await assertSource()
    const decisions = plan.operatorDecisions.map((decision) => {
      const row = staged.get(decision.sourceTable, decision.sourceKey, decision.sourcePhase)
      return {
        decision,
        state:
          row && operatorDecisionRowDigest(row) !== decision.rowDigest
            ? ('stale' as const)
            : ('unused' as 'unused' | 'consumed'),
      }
    })
    const findDecision = (row: SourceRow, blockCode: 'v2-code-history-unfinished') =>
      decisions.find(
        ({ decision, state }) =>
          state !== 'stale' &&
          decision.sourceTable === row.table &&
          decision.sourcePhase === row.phase &&
          decision.sourceKey === row.encodedKey &&
          decision.blockCode === blockCode &&
          decision.rowDigest === operatorDecisionRowDigest(row),
      )
    const lookup = await buildLookups(resolved.lookups, staged, input.progress)
    const stagingDigest = staged.digest()
    const opened = await sink.open({
      ...(input.preflight.contract === null ? {} : { sourceContract: input.preflight.contract }),
      planDigest: plan.digest,
      sourceWatermark: input.preflight.watermark,
      sourceVersion: input.preflight.sourceVersion,
      sourceGenerationId: input.preflight.sourceGenerationId,
      targetGeneration: input.targetGeneration,
      converterVersion: plan.converterVersion,
      ruleSetDigest: plan.ruleSetDigest,
      preUpgradeWatermark: plan.preUpgradeWatermark,
      stagingDigest,
      lookupDigest: unorderedDigest(
        resolved.lookups.map((builder) => canonicalSchemaJson(lookup(builder.key).version)),
      ),
    })
    const pendingCommitted = new Set(opened.committedUnitIds)
    const receipts = new Map<
      string,
      {
        counts: ReturnType<typeof emptyCounts>
        units: number
        exceptions: number
        historyOnly: number
        targets: Map<string, Set<string>>
      }
    >()
    const records: MigrationRecord[] = []
    const historyOnly: RowDisposition[] = []
    const target = targetRegistryView(input.target)
    for (const rule of rules) {
      const rulePreflight =
        rule.sourcePhase === 'pre-upgrade' ? input.preUpgradePreflight! : input.preflight
      const validators = resolved.validators.filter(
        (validator) =>
          rule.claims.includes(validator.table) &&
          (validator.sourcePhase ?? 'current') === (rule.sourcePhase ?? 'current'),
      )
      const keys = new Map<string, LookupKey<unknown>>()
      const include = (key: LookupKey<unknown>): void => {
        const id = lookupIdentity(key)
        if (keys.has(id)) return
        keys.set(id, key)
        for (const dependency of resolved.lookups.find(
          (builder) => lookupIdentity(builder.key) === id,
        )?.dependsOn ?? [])
          include(dependency)
      }
      for (const key of [
        ...rule.lookups,
        ...validators.flatMap((validator) => validator.lookups ?? []),
      ])
        include(key)
      const versions = [...keys.values()]
        .map((key) => lookup(key).version)
        .sort((a, b) => lookupIdentity(a).localeCompare(lookupIdentity(b)))
      for (const planned of ruleUnits(rule, staged, lookup, plan.chunkLimit)) {
        const rows = [...planned.unit.rows.values()].flat()
        const collector = createUnitCollector({
          rule,
          sourceRows: rows,
          sourceVersion: rulePreflight.sourceVersion,
          sourceContract: rulePreflight.contract?.digest ?? rulePreflight.fingerprint.digest,
          target,
          topology: plan.topology.order,
        })
        const context: RuleContext = {
          sourceVersion: rulePreflight.sourceVersion,
          sourceProvider: rulePreflight.fingerprint.provider,
          sourceGenerationId: rulePreflight.sourceGenerationId,
          preflight: input.preflight,
          ...(input.preUpgradePreflight ? { preUpgradePreflight: input.preUpgradePreflight } : {}),
          planTime: input.planTime,
          target,
          lookup: restrictLookups(lookup, rule.lookups),
          ids: { child: deterministicChildId },
          content: input.content,
          operatorDecisions: {
            find: (row, blockCode) => findDecision(row, blockCode)?.decision ?? null,
            consume(row, blockCode) {
              const entry = findDecision(row, blockCode)
              if (!entry) return null
              entry.state = 'consumed'
              return entry.decision
            },
          },
          out: collector.out,
        }
        for (const row of rows) {
          if (row.codecFailure)
            collector.out.block(
              rowBlock(
                BLOCK_CODES.sourceCodec,
                row,
                { message: row.codecFailure.message, raw: canonicalSchemaJson(row.raw) },
                row.codecFailure.columns,
              ),
            )
          if (planned.orphan)
            collector.out.block(rowBlock(BLOCK_CODES.orphanGroup, row, { rule: rule.ref.id }))
          for (const validator of validators.filter((validator) => validator.table === row.table))
            if (!row.codecFailure)
              for (const block of await validator.validate(row, {
                ...context,
                lookup: restrictLookups(lookup, validator.lookups ?? []),
              }))
                collector.out.block(block)
        }
        const groupBlocked =
          rule.unit.kind === 'group' && rows.some((row) => collector.blocked(row))
        if (groupBlocked)
          for (const row of rows)
            if (!collector.blocked(row))
              collector.out.block(
                rowBlock(BLOCK_CODES.groupMemberBlocked, row, { rule: rule.ref.id }),
              )
        if (
          !planned.orphan &&
          !groupBlocked &&
          (rows.length === 0 || rows.some((row) => !collector.blocked(row)))
        )
          await rule.convert(
            {
              ...planned.unit,
              rows: new Map(
                [...planned.unit.rows].map(([table, rows]) => [
                  table,
                  rows.filter((row) => !collector.blocked(row)),
                ]),
              ),
            },
            context,
          )
        const unitId = `cu1_${valueDigest([plan.digest, rule.ref, planned.ref]).slice(7)}`
        const output = collector.finish({ unit: planned.ref, unitId, lookups: versions })
        // Replay committed units through the idempotent sink to verify the payload digest too.
        await sink.commitUnit(output)
        completedUnits++
        input.progress?.({
          phase: 'conversion',
          detail: rule.ref.id,
          completed: completedUnits,
          unit: 'units',
        })
        pendingCommitted.delete(unitId)
        observer?.unit(output, rows, (row) => collector.links(row))
        blocks.push(...output.blocks)
        records.push(...output.records)
        historyOnly.push(
          ...output.dispositions.filter((disposition) => disposition.kind === 'history-only'),
        )
        for (const source of output.receipt.sources) {
          const key = sourceIdentity(source.table, source.phase)
          const receipt = receipts.get(key) ?? {
            counts: emptyCounts(),
            units: 0,
            exceptions: 0,
            historyOnly: 0,
            targets: new Map<string, Set<string>>(),
          }
          addCounts(receipt.counts, source.counts)
          receipt.units++
          receipt.exceptions += source.exceptions
          receipt.historyOnly += source.historyOnly
          for (const row of rows.filter((row) => row.table === source.table))
            for (const ref of collector.links(row)) {
              const set = receipt.targets.get(ref.table) ?? new Set<string>()
              set.add(ref.key)
              receipt.targets.set(ref.table, set)
            }
          receipts.set(key, receipt)
        }
      }
    }
    if (pendingCommitted.size)
      throw new ConversionContractError(
        'v2-unexpected-committed-unit',
        [...pendingCommitted].join(','),
      )
    for (const { decision, state } of decisions)
      if (state !== 'consumed')
        blocks.push({
          code: state === 'stale' ? 'v2-operator-decision-stale' : 'v2-operator-decision-unused',
          scope: 'row',
          sourceTable: decision.sourceTable,
          sourceKey: decision.sourceKey,
          sourcePhase: decision.sourcePhase,
          taskId: null,
          runId: null,
          missingFields: [],
          detail: { decision },
        })
    const activeClaims = new Map<string, Map<EncodedKey, TableReceipt['activeClaims'][number]>>()
    for (const record of records) {
      if (
        record.kind !== 'source-metadata' ||
        !record.payload ||
        typeof record.payload !== 'object' ||
        Array.isArray(record.payload)
      )
        continue
      const payload = record.payload as { readonly [key: string]: JsonValue }
      if (payload.kind !== 'active-claim') continue
      if (
        typeof payload.sourceKey !== 'string' ||
        !payload.sourceKey.startsWith('mk1:') ||
        !['current', 'pre-upgrade'].includes(String(payload.sourcePhase)) ||
        !payload.values ||
        typeof payload.values !== 'object' ||
        Array.isArray(payload.values)
      )
        throw new ConversionContractError('v2-active-claim-record', record.table)
      const key = sourceIdentity(record.table, payload.sourcePhase as 'current' | 'pre-upgrade')
      const claims =
        activeClaims.get(key) ?? new Map<EncodedKey, TableReceipt['activeClaims'][number]>()
      const claim = {
        sourceKey: payload.sourceKey as EncodedKey,
        values: payload.values as TableReceipt['activeClaims'][number]['values'],
      }
      const prior = claims.get(claim.sourceKey)
      if (prior && valueDigest(prior) !== valueDigest(claim))
        throw new ConversionContractError('v2-active-claim-conflict', claim.sourceKey)
      claims.set(claim.sourceKey, claim)
      activeClaims.set(key, claims)
    }
    const tableReceipts: TableReceipt[] = plan.tables.map((table) => {
      const keys: string[] = []
      const contents: string[] = []
      for (const row of staged.rows(table.table, table.phase)) {
        keys.push(row.encodedKey)
        contents.push(
          bytesDigest(canonicalSchemaJson({ canonical: row.canonical, raw: row.raw ?? null })),
        )
      }
      const receipt = receipts.get(sourceIdentity(table.table, table.phase))
      const counts = receipt?.counts ?? emptyCounts()
      if (receipt && Object.values(counts).reduce((sum, count) => sum + count, 0) !== keys.length)
        throw new ConversionContractError('v2-receipt-conservation', table.table)
      return {
        sourceTable: table.table,
        sourcePhase: table.phase,
        sourceVersion:
          table.phase === 'current'
            ? input.preflight.sourceVersion
            : input.preUpgradePreflight!.sourceVersion,
        rowsRead: keys.length,
        activeClaims: [
          ...(activeClaims.get(sourceIdentity(table.table, table.phase))?.values() ?? []),
        ].sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0)),
        targets: [...(receipt?.targets ?? [])]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([table, keys]) => ({ table, rows: keys.size })),
        counts,
        exceptions: receipt?.exceptions ?? 0,
        historyOnly: receipt?.historyOnly ?? 0,
        keyDigest: unorderedDigest(keys),
        contentDigest: unorderedDigest(contents),
        units: receipt?.units ?? 0,
      }
    })
    const summary: ConversionSummary = {
      status: blocks.length ? 'blocked' : 'converted',
      tableReceipts,
      blocks,
      records,
      historyOnly,
      stagingDigest,
      plan,
    }
    await assertSource()
    await sink.finish(summary)
    input.progress?.({
      phase: 'conversion',
      detail: 'complete',
      completed: completedUnits,
      unit: 'units',
      boundary: true,
    })
    return summary
  } finally {
    input.onStagingPeak?.(staged.peakBytes)
    staged.close()
  }
}
