import { canonicalSchemaJson } from '../../schema/canonical'
import {
  buildConversionPlan,
  resolveContributions,
  sourceIdentity,
  type ConversionInput,
  type ConversionPlanSection,
} from './plan'
import { createStagingStore, type StagingStore } from './staging'
import { createReclaimer } from './reclaim'
import {
  createLookupSet,
  restrictLookups,
  lookupIdentity,
  type LookupKey,
  type LookupResolver,
} from './lookups'
import { TASK_FACTS } from './lookups/keys'
import { stageSourceTable } from './readSource'
import { targetRegistryView } from './targetRows'
import { createUnitCollector, emptyCounts, addCounts, type UnitCollector } from './receipts'
import { requiredSeedRows } from './requiredSeeds'
import { deterministicChildId } from './ids'
import { orderedDigest, unorderedDigest, valueDigest } from './digest'
import { BLOCK_CODES, ConversionContractError, rowBlock } from './blockCodes'
import { canonicalValue } from './migrationKey'
import { operatorDecisionRowDigest, RESOLUTION_CODES } from './types'
import type {
  ConversionRule,
  ConversionUnit,
  RowValidator,
  RuleContext,
  SettlesDeclaration,
} from './rule'
import {
  RESOLUTION_LIST_LIMIT,
  type ConversionResolutions,
  type ConversionSink,
  type ConversionSummary,
} from './sink'
import type {
  ConversionBlock,
  EncodedKey,
  LoadRejectionDecision,
  LookupVersion,
  RowDisposition,
  MigrationRecord,
  OperatorDecision,
  SettlementRewrite,
  SourcePhase,
  SourceRow,
  TableReceipt,
  TaskSettlement,
  UnitOutput,
  UnitRef,
  TargetRef,
  TargetValue,
  JsonValue,
} from './types'

interface PlannedUnit {
  readonly ref: UnitRef
  readonly unit: ConversionUnit
  readonly orphan?: boolean
}
/**
 * The units of one rule, in conversion order. `readGroups` (RFC-626 discovery) is asked about
 * each batch of groups before its rows are read; a batch it declines is skipped unread. Batches
 * are formed from all groups first, so every unit that is read holds exactly the rows the
 * conversion gives that unit, whatever was skipped around it.
 */
function* ruleUnits(
  rule: ConversionRule,
  staged: StagingStore,
  resolve: LookupResolver,
  limit: number,
  readGroups?: (groupKeys: readonly string[]) => boolean,
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
    const unitIndex = index++
    if (readGroups && !readGroups(keys)) continue
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
        index: unitIndex,
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
/**
 * RFC-626: a conversion whose source is staged and whose plan is final. With automatic
 * resolution the plan already names the tasks the conversion ends, which is why the target
 * run can only be registered after this step. The staging store stays open until `close`.
 */
export interface PreparedConversion {
  readonly plan: ConversionPlanSection
  run(sink: ConversionSink, observer?: ConversionObserver): Promise<ConversionSummary>
  close(): void
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
  const prepared = await prepareConversion(input)
  try {
    return await prepared.run(sink, observer)
  } finally {
    prepared.close()
  }
}
/** The tasks a row belongs to when a declaration does not say: its `task_id`, or `tasks.id`. */
function defaultTasksOf(row: SourceRow): readonly string[] | undefined {
  const text = (value: TargetValue | undefined): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null
  const id = text(row.values.task_id) ?? (row.table === 'tasks' ? text(row.values.id) : null)
  return id === null ? undefined : [id]
}
/**
 * RFC-626 §3.7: the one task a source row belongs to, for the report of missing content: the
 * task its `settles` declaration names, else its own (`defaultTasksOf`); null when it names none
 * or several (content of no task, such as a skill file, or content shared by tasks).
 */
function taskOfRow(
  row: SourceRow | undefined,
  tasksOf: ((row: SourceRow) => readonly string[] | undefined) | null,
): string | null {
  if (!row) return null
  const only = (tasks: readonly string[] | undefined): string | null =>
    tasks && new Set(tasks).size === 1 ? tasks[0]! : null
  return only(tasksOf?.(row)) ?? only(defaultTasksOf(row))
}
export async function prepareConversion(input: ConversionInput): Promise<PreparedConversion> {
  input.progress?.({ phase: 'conversion', detail: 'start', boundary: true })
  const automatic = input.resolution === 'automatic'
  const resolved = resolveContributions(input)
  // Settlements never change which tables and rules take part; only the digest differs.
  const basePlan = buildConversionPlan(input, resolved)
  const rules = resolved.rules.filter((rule) =>
    basePlan.tables.some((table) => table.rule === rule.ref.id),
  )
  const staged = createStagingStore(input.scratchRoot, input.progress)
  // RFC-626 §4.7: full collections at table and unit boundaries, see `createReclaimer`.
  const reclaim = input.reclaim ?? createReclaimer()
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    input.onStagingPeak?.(staged.peakBytes)
    staged.close()
  }
  const assertSource = async (): Promise<void> => {
    await input.source.assertUnchanged(input.preflight)
    if (input.preUpgradeSource && input.preUpgradePreflight)
      await input.preUpgradeSource.assertUnchanged(input.preUpgradePreflight)
  }
  try {
    await assertSource()
    const needed = new Map<string, { table: string; phase: SourcePhase; raw: boolean }>()
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
    const stagingBlocks: ConversionBlock[] = []
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
        limit: basePlan.chunkLimit,
        staged,
        codecTakeovers,
        progress: input.progress,
        reclaim,
      })
      reclaim()
      if (staged.count(entry.table, entry.phase) !== declaration.rows)
        stagingBlocks.push({
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
    const decisions = basePlan.operatorDecisions.map((decision) => {
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
    /** RFC-626: the acknowledgement the automatic upgrade gives for a row, on the row as it is now. */
    const automaticDecision = (
      row: SourceRow,
      blockCode: 'v2-code-history-unfinished',
    ): OperatorDecision => ({
      kind: 'acknowledge-unfinished-legacy-work',
      sourceTable: row.table,
      sourceKey: row.encodedKey,
      sourcePhase: row.phase,
      rowDigest: operatorDecisionRowDigest(row),
      blockCode,
      acknowledgedBy: 'automatic-upgrade',
      acknowledgedAt: input.planTime,
      reason: 'automatic upgrade archives unfinished work of a retired feature',
    })
    const lookups = await createLookupSet(resolved.lookups, staged, input.progress)
    const lookup = lookups.resolve
    const target = targetRegistryView(input.target)
    const requiredSeed = requiredSeedRows(input.target)
    const hasTaskFacts = resolved.lookups.some(
      (builder) => lookupIdentity(builder.key) === lookupIdentity(TASK_FACTS),
    )
    const isExecutable = (taskId: string): boolean =>
      hasTaskFacts && lookup(TASK_FACTS).get(taskId)?.execution === 'executable'
    const validatorsOf = (rule: ConversionRule): readonly RowValidator[] =>
      resolved.validators.filter(
        (validator) =>
          rule.claims.includes(validator.table) &&
          (validator.sourcePhase ?? 'current') === (rule.sourcePhase ?? 'current'),
      )
    const lookupVersions = (
      rule: ConversionRule,
      validators: readonly RowValidator[],
    ): readonly LookupVersion[] => {
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
      return [...keys.values()]
        .map((key) => lookup(key).version)
        .sort((a, b) => lookupIdentity(a).localeCompare(lookupIdentity(b)))
    }
    /** The declaration that applies to one row: the rule's and its table's validators'. */
    const settlesOf = (
      rule: ConversionRule,
      validators: readonly RowValidator[],
    ): ((row: SourceRow) => readonly string[] | undefined) | null => {
      const declared: {
        readonly table: string | null
        readonly settles: SettlesDeclaration
        readonly lookups: readonly LookupKey<unknown>[]
      }[] = [
        ...(rule.settles ? [{ table: null, settles: rule.settles, lookups: rule.lookups }] : []),
        ...validators.flatMap((validator) =>
          validator.settles
            ? [
                {
                  table: validator.table,
                  settles: validator.settles,
                  lookups: validator.lookups ?? [],
                },
              ]
            : [],
        ),
      ]
      if (!declared.length) return null
      return (row) => {
        let tasks: string[] | undefined
        for (const entry of declared) {
          if (entry.table !== null && entry.table !== row.table) continue
          const found = entry.settles.tasksOf
            ? entry.settles.tasksOf(row, restrictLookups(lookup, entry.lookups))
            : defaultTasksOf(row)
          if (found !== undefined) tasks = [...(tasks ?? []), ...found]
        }
        return tasks === undefined ? undefined : [...new Set(tasks)]
      }
    }
    /**
     * RFC-626 §3.2.2 step 2: the tasks that cover a whole group, when every declaration that
     * applies to the rule's rows (its own and its validators') says so through `tasksOfGroup`;
     * null when one of them does not. Undefined from a declaration: that group must be read.
     */
    const groupSettlesOf = (
      rule: ConversionRule,
      validators: readonly RowValidator[],
    ): ((groupKey: string) => readonly string[] | undefined) | null => {
      const declared = [
        ...(rule.settles ? [{ settles: rule.settles, lookups: rule.lookups }] : []),
        ...validators.flatMap((validator) =>
          validator.settles
            ? [{ settles: validator.settles, lookups: validator.lookups ?? [] }]
            : [],
        ),
      ]
      if (!declared.length || declared.some((entry) => !entry.settles.tasksOfGroup)) return null
      return (groupKey) => {
        const tasks: string[] = []
        for (const entry of declared) {
          const found = entry.settles.tasksOfGroup!(
            groupKey,
            restrictLookups(lookup, entry.lookups),
          )
          if (found === undefined) return undefined
          tasks.push(...found)
        }
        return tasks
      }
    }
    /**
     * RFC-626: a row of a `preservedClaims` table is a record attached to its group (the
     * operation records of a skill). Blocked or set aside on its own — undecodable, or refused
     * by the target — it takes only itself out of the unit, as it did while the generic copy
     * carried it. A blocked row of any other table still takes its whole group along, and the
     * attached records go with it.
     */
    const attachedToGroup = (rule: ConversionRule, row: SourceRow): boolean =>
      rule.preservedClaims?.includes(row.table) ?? false
    /** Runs one unit through its rule. Both discovery and the conversion go through here. */
    const collectUnit = async (
      rule: ConversionRule,
      planned: PlannedUnit,
      validators: readonly RowValidator[],
      options: {
        readonly mode: 'convert' | 'discover'
        readonly loadRejections?: readonly LoadRejectionDecision[]
        readonly acknowledged?: SourceRow[]
      },
    ): Promise<{ collector: UnitCollector; rows: readonly SourceRow[] }> => {
      const rulePreflight =
        rule.sourcePhase === 'pre-upgrade' ? input.preUpgradePreflight! : input.preflight
      const rows = [...planned.unit.rows.values()].flat()
      const tasksOf = settlesOf(rule, validators)
      const collector = createUnitCollector({
        rule,
        sourceRows: rows,
        sourceVersion: rulePreflight.sourceVersion,
        sourceContract: rulePreflight.contract?.digest ?? rulePreflight.fingerprint.digest,
        target,
        topology: basePlan.topology.order,
        resolution: input.resolution ?? 'operator',
        mode: options.mode,
        ...(tasksOf ? { settles: { tasksOf, isExecutable } } : {}),
        requiredSeed,
        ...(options.loadRejections?.length ? { loadRejections: options.loadRejections } : {}),
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
        operatorDecisions: automatic
          ? {
              find: (row, blockCode) => automaticDecision(row, blockCode),
              consume(row, blockCode) {
                options.acknowledged?.push(row)
                return automaticDecision(row, blockCode)
              },
            }
          : {
              find: (row, blockCode) => findDecision(row, blockCode)?.decision ?? null,
              consume(row, blockCode) {
                const entry = findDecision(row, blockCode)
                if (!entry) return null
                if (options.mode === 'convert') entry.state = 'consumed'
                return entry.decision
              },
            },
        resolution: input.resolution ?? 'operator',
        out: collector.out,
      }
      for (const row of rows) {
        // A row the target already refused is out of this unit before anything looks at it.
        if (collector.blocked(row)) continue
        // RFC-626: a rule that accounts for every row of its table in one output takes the
        // rows the frozen codec rejected as they were read.
        if (row.codecFailure && !(automatic && rule.takesUndecodedRows))
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
              if ('executable' in block)
                collector.validatorBlockExecutable(
                  Boolean(validator.settles),
                  block.executable,
                  block.block,
                )
              else collector.out.block(block)
      }
      const groupBlocked =
        rule.unit.kind === 'group' &&
        rows.some((row) => collector.blocked(row) && !attachedToGroup(rule, row))
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
      return { collector, rows }
    }

    // ---- RFC-626: find the unfinished tasks this conversion has to end ----------------------
    const settled = new Map<string, TaskSettlement>()
    const applySettlements = async (batch: readonly TaskSettlement[]): Promise<void> => {
      const rewrites = new Map<
        string,
        {
          table: string
          phase: SourcePhase
          key: string
          values: SourceRow['values']
          settlement: SettlementRewrite
        }
      >()
      // Every settler reads the rows as they were before this batch; all writes happen after.
      for (const settlement of batch)
        for (const contribution of resolved.settlements)
          for (const settler of contribution.settlers) {
            const rows = new Map<string, readonly SourceRow[]>()
            for (const entry of settler.tables)
              if (!entry.via)
                rows.set(
                  entry.table,
                  staged.group(entry.table, entry.taskColumn, settlement.taskId),
                )
            // Rows that point at the task's rows are found through those rows.
            for (const entry of settler.tables) {
              if (!entry.via) continue
              const base = settler.tables.find((other) => other.table === entry.via!.table)
              const through = base && !base.via ? rows.get(base.table) : undefined
              if (!through)
                throw new ConversionContractError(
                  'v2-settlement-via',
                  `${entry.table} via ${entry.via.table}`,
                )
              const found = new Map<string, SourceRow>()
              for (const key of new Set(
                through.flatMap((row) => {
                  const value = row.values[entry.via!.keyColumn]
                  return typeof value === 'string' ? [value] : []
                }),
              ))
                for (const row of staged.group(entry.table, entry.taskColumn, key))
                  found.set(row.encodedKey, row)
              rows.set(
                entry.table,
                [...found.values()].sort((a, b) =>
                  Buffer.compare(Buffer.from(a.encodedKey), Buffer.from(b.encodedKey)),
                ),
              )
            }
            for (const change of settler.settle(rows, { settlement, planTime: input.planTime })) {
              const declared = settler.tables.find((entry) => entry.table === change.table)
              const stored = rows.get(change.table)?.find((row) => row.encodedKey === change.key)
              if (!declared || declared.write === false || !stored)
                throw new ConversionContractError(
                  'v2-settlement-row',
                  `${change.table}/${change.key}`,
                )
              const id = JSON.stringify([stored.phase, change.table, change.key])
              // Every settler saw the row as it was before this batch, so what it returns is
              // that row with its own columns changed. Two settlers may touch one row: their
              // columns are merged, and only two different values for one column conflict.
              const prior = rewrites.get(id)
              const columns: Record<string, SettlementRewrite['columns'][string]> = {
                ...prior?.settlement.columns,
              }
              const values: Record<string, TargetValue> = { ...(prior?.values ?? stored.values) }
              let changed = false
              for (const name of new Set([
                ...Object.keys(stored.values),
                ...Object.keys(change.values),
              ])) {
                const before = canonicalValue(stored.values[name] ?? null)
                const after = canonicalValue(change.values[name] ?? null)
                if (canonicalSchemaJson(before) === canonicalSchemaJson(after)) continue
                const earlier = columns[name]
                if (earlier && canonicalSchemaJson(earlier.after) !== canonicalSchemaJson(after))
                  throw new ConversionContractError('v2-settlement-conflict', `${id}.${name}`)
                columns[name] = { before, after }
                values[name] = change.values[name] ?? null
                changed = true
              }
              if (!changed) continue
              rewrites.set(id, {
                table: change.table,
                phase: stored.phase,
                key: change.key,
                values: values as SourceRow['values'],
                settlement: { taskId: settlement.taskId, cause: settlement.cause, columns },
              })
            }
          }
      staged.rewrite([...rewrites.values()])
      for (const settlement of batch) settled.set(settlement.taskId, settlement)
      await lookups.rebuild(staged.rewrittenTables())
    }
    const discover = async (): Promise<Map<string, Set<string>>> => {
      const found = new Map<string, Set<string>>()
      for (const rule of rules) {
        const validators = validatorsOf(rule)
        const tasksOf = settlesOf(rule, validators)
        if (!tasksOf) continue
        const relevant = (row: SourceRow): boolean => {
          const tasks = tasksOf(row)
          return tasks === undefined || tasks.some(isExecutable)
        }
        // A batch of groups none of whose covering tasks can continue is not even read.
        const groupTasksOf = rule.unit.kind === 'group' ? groupSettlesOf(rule, validators) : null
        const readGroups = groupTasksOf
          ? (keys: readonly string[]): boolean =>
              keys.some((key) => {
                if (isExecutable(key)) return true
                const tasks = groupTasksOf(key)
                return tasks === undefined || tasks.some(isExecutable)
              })
          : undefined
        for (const planned of ruleUnits(rule, staged, lookup, basePlan.chunkLimit, readGroups)) {
          const rows = [...planned.unit.rows.values()].flat()
          const groupKeys = planned.unit.groupKeys ?? []
          // A unit matters when one of its rows, or for a group the task it is keyed by, can
          // still end a task. It is then converted whole, as the conversion converts it: checks
          // across the rows of a unit (a target key two rows produce) must see the same rows,
          // or a row the conversion sets aside would end a task discovery never named.
          if (!rows.some(relevant) && !groupKeys.some(isExecutable)) continue
          const { collector } = await collectUnit(rule, planned, validators, { mode: 'discover' })
          // Rule contract checks run in `finish`; a row they set aside ends its task as well.
          collector.finish({ unit: planned.ref, unitId: 'discovery', lookups: [] })
          for (const trigger of collector.settlementTriggers()) {
            const codes = found.get(trigger.taskId) ?? new Set<string>()
            codes.add(trigger.code)
            found.set(trigger.taskId, codes)
          }
          reclaim()
        }
      }
      return found
    }
    if (automatic) {
      if (input.settlements?.length) await applySettlements(input.settlements)
      for (;;) {
        const pending = new Map<string, TaskSettlement>()
        for (const [taskId, codes] of await discover()) {
          if (settled.has(taskId)) continue
          // Ending a task rewrites it to canceled. A rule that names a task which is not
          // unfinished would have a finished task rewritten, so that is a rule fault.
          if (!isExecutable(taskId))
            throw new ConversionContractError(
              'v2-settlement-not-executable',
              `${taskId}: ${[...codes].sort().join(',')}`,
            )
          pending.set(taskId, {
            taskId,
            cause: 'unprovable-records',
            originalStatus: lookup(TASK_FACTS).get(taskId)?.status ?? 'unknown',
            blockCodes: [...codes].sort(),
            parentTaskId: null,
          })
        }
        for (let grew = true; grew; ) {
          grew = false
          for (const contribution of resolved.settlements)
            for (const extra of contribution.expand?.({
              settled: new Map([...settled, ...pending]),
              staged,
            }) ?? [])
              if (!settled.has(extra.taskId) && !pending.has(extra.taskId)) {
                pending.set(extra.taskId, extra)
                grew = true
              }
        }
        if (!pending.size) break
        // A registered set is complete by construction: the same frozen source gave it.
        if (input.settlements)
          throw new ConversionContractError(
            'v2-settlement-drift',
            [...pending.keys()].sort().join(','),
          )
        await applySettlements([...pending.values()])
        input.progress?.({
          phase: 'conversion',
          detail: 'tasks ended by the upgrade',
          completed: settled.size,
          unit: 'tasks',
        })
      }
    }
    const plan = automatic
      ? buildConversionPlan({ ...input, settlements: [...settled.values()] }, resolved)
      : basePlan

    const run = async (
      sink: ConversionSink,
      observer?: ConversionObserver,
    ): Promise<ConversionSummary> => {
      let completedUnits = 0
      const blocks: ConversionBlock[] = [...plan.blocks, ...stagingBlocks]
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
        }
      >()
      const records: MigrationRecord[] = []
      const historyOnly: RowDisposition[] = []
      const setAside: ConversionResolutions['setAside']['rows'][number][] = []
      const missingContent: ConversionResolutions['missingContent']['rows'][number][] = []
      const keptByCode = new Map<string, number>()
      const kept: ConversionResolutions['kept']['rows'][number][] = []
      const acknowledgedByCode = new Map<string, number>()
      let setAsideTotal = 0
      let missingContentTotal = 0
      for (const rule of rules) {
        const validators = validatorsOf(rule)
        const versions = lookupVersions(rule, validators)
        const ownTasksOf = settlesOf(rule, validators)
        for (const planned of ruleUnits(rule, staged, lookup, plan.chunkLimit)) {
          const unitId = `cu1_${valueDigest([plan.digest, rule.ref, planned.ref]).slice(7)}`
          let rejections: readonly LoadRejectionDecision[] =
            opened.loadRejections?.get(unitId) ?? []
          let collector: UnitCollector
          let rows: readonly SourceRow[]
          let output: UnitOutput
          for (;;) {
            const acknowledged: SourceRow[] = []
            ;({ collector, rows } = await collectUnit(rule, planned, validators, {
              mode: 'convert',
              loadRejections: rejections,
              acknowledged,
            }))
            for (const row of acknowledged)
              collector.out.record({
                kind: 'decision',
                code: 'v2-code-history-unfinished',
                payload: {
                  automatic: 'acknowledged',
                  sourcePhase: row.phase,
                  sourceTable: row.table,
                  sourceKey: row.encodedKey,
                  // What a person's decision would have carried: who, when, on which row.
                  acknowledgedBy: 'automatic-upgrade',
                  acknowledgedAt: input.planTime,
                  rowDigest: operatorDecisionRowDigest(row),
                },
              })
            output = collector.finish({ unit: planned.ref, unitId, lookups: versions })
            // Replay committed units through the idempotent sink to verify the payload digest too.
            const refused = await sink.commitUnit(output)
            if (!refused || !refused.rejected.length) break
            if (!automatic)
              throw new ConversionContractError('v2-load-rejection-unexpected', unitId)
            // RFC-626: set aside the source row of every refused target row, then commit again.
            const bySource = new Map<string, LoadRejectionDecision>()
            for (const rejected of refused.rejected) {
              const origin = collector.originOfTarget(rejected.table, rejected.targetKey)
              if (!origin)
                throw new ConversionContractError(
                  'v2-load-rejection-origin',
                  `${rejected.table}/${rejected.targetKey}`,
                )
              const prior = bySource.get(origin.encodedKey)
              bySource.set(origin.encodedKey, {
                sourcePhase: origin.phase,
                sourceTable: origin.table,
                sourceKey: origin.encodedKey,
                targets: [
                  ...(prior?.targets ?? []),
                  {
                    table: rejected.table,
                    key: rejected.targetKey,
                    constraint: rejected.constraint,
                    message: rejected.message,
                  },
                ].sort((a, b) => {
                  const left = canonicalSchemaJson([a.table, a.key, a.constraint])
                  const right = canonicalSchemaJson([b.table, b.key, b.constraint])
                  return left < right ? -1 : left > right ? 1 : 0
                }),
              })
            }
            rejections = [...rejections, ...bySource.values()].sort((a, b) => {
              const left = canonicalSchemaJson([a.sourcePhase, a.sourceTable, a.sourceKey])
              const right = canonicalSchemaJson([b.sourcePhase, b.sourceTable, b.sourceKey])
              return left < right ? -1 : left > right ? 1 : 0
            })
          }
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
          if (automatic) {
            for (const record of output.records) {
              if (record.kind !== 'decision') continue
              const payload =
                record.payload &&
                typeof record.payload === 'object' &&
                !Array.isArray(record.payload)
                  ? (record.payload as { readonly [key: string]: JsonValue })
                  : null
              if (record.code === RESOLUTION_CODES.rowSetAside && payload) {
                setAsideTotal++
                if (setAside.length < RESOLUTION_LIST_LIMIT)
                  setAside.push({
                    sourcePhase: payload.sourcePhase as SourcePhase,
                    sourceTable: String(payload.sourceTable),
                    sourceKey: String(payload.sourceKey) as EncodedKey,
                    code: String(payload.code),
                  })
              } else if (payload?.automatic === 'kept') {
                keptByCode.set(record.code, (keptByCode.get(record.code) ?? 0) + 1)
                if (
                  kept.length < RESOLUTION_LIST_LIMIT &&
                  typeof payload.sourceTable === 'string' &&
                  typeof payload.sourceKey === 'string'
                )
                  kept.push({
                    sourceTable: payload.sourceTable,
                    sourceKey: payload.sourceKey as EncodedKey,
                    code: record.code,
                  })
              } else if (payload?.automatic === 'acknowledged')
                acknowledgedByCode.set(record.code, (acknowledgedByCode.get(record.code) ?? 0) + 1)
            }
            for (const artifact of output.artifacts)
              if (artifact.missing) {
                missingContentTotal++
                if (missingContent.length < RESOLUTION_LIST_LIMIT)
                  missingContent.push({
                    sourceTable: artifact.sourceTable,
                    sourceKey: artifact.sourceKey,
                    sourceColumn: artifact.sourceColumn,
                    reference: artifact.originalReference,
                    state: artifact.missing.state,
                    taskId: taskOfRow(
                      rows.find((row) => row.encodedKey === artifact.sourceKey),
                      ownTasksOf,
                    ),
                  })
              }
          }
          for (const source of output.receipt.sources) {
            const key = sourceIdentity(source.table, source.phase)
            const receipt = receipts.get(key) ?? {
              counts: emptyCounts(),
              units: 0,
              exceptions: 0,
              historyOnly: 0,
            }
            addCounts(receipt.counts, source.counts)
            receipt.units++
            receipt.exceptions += source.exceptions
            receipt.historyOnly += source.historyOnly
            // Distinct target rows are counted in the scratch file, not held in memory.
            staged.noteTargets(
              source.table,
              source.phase,
              rows
                .filter((row) => row.table === source.table)
                .flatMap((row) => collector.links(row)),
            )
            receipts.set(key, receipt)
          }
          reclaim()
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
        const key = sourceIdentity(record.table, payload.sourcePhase as SourcePhase)
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
        // Keys keep their definition (JavaScript string order); only the key column is read.
        const keys = [...staged.keys(table.table, table.phase)]
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
          targets: staged.targetCounts(table.table, table.phase).map((entry) => ({ ...entry })),
          counts,
          exceptions: receipt?.exceptions ?? 0,
          historyOnly: receipt?.historyOnly ?? 0,
          keyDigest: unorderedDigest(keys),
          // Row digests are hex text, read in sorted order: the same value `unorderedDigest` gives.
          contentDigest: orderedDigest(staged.rowDigests(table.table, table.phase)),
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
        ...(automatic
          ? {
              resolutions: {
                settledTasks: plan.settlements ?? [],
                setAside: { total: setAsideTotal, rows: setAside },
                missingContent: { total: missingContentTotal, rows: missingContent },
                kept: {
                  total: [...keptByCode.values()].reduce((sum, count) => sum + count, 0),
                  byCode: Object.fromEntries(
                    [...keptByCode].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
                  ),
                  rows: kept,
                },
                acknowledged: {
                  total: [...acknowledgedByCode.values()].reduce((sum, count) => sum + count, 0),
                  byCode: Object.fromEntries(
                    [...acknowledgedByCode].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
                  ),
                },
              },
            }
          : {}),
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
    }
    return { plan, run, close }
  } catch (error) {
    close()
    throw error
  }
}
