// RFC-616 §5.2 / §7 — the numbers of one unit, and the headline numbers of a
// set of units.
//
// Sampling rules (proposal §5):
//   - time and first-pass statistics: succeeded units only;
//   - token and cost statistics: ended units that have usage records;
//   - rates over executions: every unit;
//   - active units appear in listings but in no statistic.

import {
  PROCESS_CAUSE_GROUPS,
  PROCESS_CAUSE_GROUP_OF,
  PROCESS_GATE_KINDS,
  type ProcessCause,
  type ProcessCauseGroup,
  type ProcessCauseSlice,
  type ProcessGateKind,
  type ProcessInterventions,
  type ProcessMetricId,
  type ProcessStability,
  type ProcessTimeSplit,
  type ProcessTrendPoint,
  type ProcessUnitCounts,
  type ProcessUnitRow,
} from '@agent-workflow/shared'
import { dayIndex, dayLabel } from '../statistics'
import { INTERVENTION_ACTIONS, RECOVERY_ACTIONS, unitEnded, type ProcessUnitFacts } from './model'
import { apportion, mean, ratio, statOf, sum } from './stats'
import { splitUnitTime, type ProcessUnitTime } from './timeline'

export interface ProcessUnitNumbers {
  readonly facts: ProcessUnitFacts
  readonly time: ProcessUnitTime
  /** Ended and started after the first recorded runtime call. */
  readonly tokenSample: boolean
  readonly causeTokens: ReadonlyMap<
    ProcessCause,
    { readonly tokens: number; readonly costNano: number }
  >
  readonly causeActiveMs: ReadonlyMap<ProcessCause, number>
  /** Closed, non-void gate rounds by kind. */
  readonly gateRounds: ReadonlyMap<ProcessGateKind, number>
  readonly operations: number
  readonly interventions: number
  readonly autoRetries: number
  readonly failedRuns: number
  readonly interruptedRuns: number
  readonly recoveries: number
  /** null: not applicable (the unit did not succeed, or the kind cannot judge it). */
  readonly firstPass: boolean | null
}

export function unitNumbers(facts: ProcessUnitFacts, now: number): ProcessUnitNumbers {
  const causeTokens = new Map<ProcessCause, { tokens: number; costNano: number }>()
  for (const slice of facts.usage) {
    const previous = causeTokens.get(slice.cause)
    causeTokens.set(slice.cause, {
      tokens: (previous?.tokens ?? 0) + slice.tokens,
      costNano: (previous?.costNano ?? 0) + slice.costNano,
    })
  }
  const causeActiveMs = new Map<ProcessCause, number>()
  let autoRetries = 0
  let reviewRework = 0
  let failedRuns = 0
  let interruptedRuns = 0
  let recoveries = 0
  for (const execution of facts.executions) {
    causeActiveMs.set(
      execution.cause,
      (causeActiveMs.get(execution.cause) ?? 0) + execution.activeMs,
    )
    failedRuns += execution.failedRuns
    interruptedRuns += execution.interruptedRuns
    if (execution.cause === 'auto-retry') autoRetries += execution.runs
    if (execution.cause === 'review-rework') reviewRework += execution.runs
    if (execution.cause === 'recovery') recoveries += execution.runs
  }
  const gateRounds = new Map<ProcessGateKind, number>()
  for (const gate of facts.gates) {
    if (gate.void || gate.closedAt === null) continue
    gateRounds.set(gate.kind, (gateRounds.get(gate.kind) ?? 0) + 1)
  }
  const operations = facts.operations.filter((operation) =>
    INTERVENTION_ACTIONS.has(operation.action),
  ).length
  const succeeded = facts.unit.status === 'succeeded'
  // "Did it fail" is judged by failed executions, not by recovery runs: the
  // ledger cannot tell a resume after a failure from one after a daemon
  // restart, but only the former leaves a failed execution behind.
  const generic =
    reviewRework === 0 &&
    autoRetries === 0 &&
    failedRuns === 0 &&
    facts.failedWrappers === 0 &&
    facts.manualRetries === 0
  const firstPass = !succeeded
    ? null
    : facts.firstPassOverride !== undefined
      ? facts.firstPassOverride
      : generic
  return {
    facts,
    time: splitUnitTime(facts.unit, facts.gates, now),
    tokenSample: unitEnded(facts.unit) && facts.hasUsageRecord,
    causeTokens,
    causeActiveMs,
    gateRounds,
    operations,
    interventions: sum([...gateRounds.values()]) + facts.manualRetries + operations,
    autoRetries,
    failedRuns,
    interruptedRuns,
    recoveries,
    firstPass,
  }
}

export function unitCounts(numbers: readonly ProcessUnitNumbers[]): ProcessUnitCounts {
  const count = (status: string) =>
    numbers.filter((item) => item.facts.unit.status === status).length
  return {
    total: numbers.length,
    succeeded: count('succeeded'),
    failed: count('failed'),
    canceled: count('canceled'),
    active: count('active'),
  }
}

const succeededOf = (numbers: readonly ProcessUnitNumbers[]) =>
  numbers.filter((item) => item.facts.unit.status === 'succeeded')
const endedOf = (numbers: readonly ProcessUnitNumbers[]) =>
  numbers.filter((item) => unitEnded(item.facts.unit))
const tokenSampleOf = (numbers: readonly ProcessUnitNumbers[]) =>
  numbers.filter((item) => item.tokenSample)

/** The headline numbers every subject kind has. */
export function commonMetrics(
  numbers: readonly ProcessUnitNumbers[],
): Partial<Record<ProcessMetricId, number | null>> {
  const succeeded = succeededOf(numbers)
  const ended = endedOf(numbers)
  const sample = tokenSampleOf(numbers)
  const timed = succeeded.filter((item) => item.time.autoMs !== null)
  const lead = statOf(succeeded.map((item) => item.time.leadMs))
  const judged = succeeded.filter((item) => item.firstPass !== null)
  const tokens = mean(sample.map((item) => item.facts.usageTotals.tokens))
  const cost = mean(sample.map((item) => item.facts.usageTotals.costNano))
  return {
    units: numbers.length,
    successRate: ratio(succeeded.length, ended.length),
    leadP50: lead.p50,
    leadP90: lead.p90,
    flowEfficiency: ratio(
      sum(timed.map((item) => item.time.autoMs ?? 0)),
      sum(timed.map((item) => item.time.leadMs)),
    ),
    tokensPerUnit: tokens === null ? null : Math.round(tokens),
    costNanoPerUnit: cost === null ? null : Math.round(cost),
    firstPassRate: ratio(judged.filter((item) => item.firstPass === true).length, judged.length),
    interventionsPerUnit: mean(ended.map((item) => item.interventions)),
  }
}

/** Mean time of a succeeded unit that has a running-time record. */
export function timeSplitOf(numbers: readonly ProcessUnitNumbers[]): ProcessTimeSplit {
  const timed = succeededOf(numbers).filter((item) => item.time.autoMs !== null)
  if (timed.length === 0) {
    return { sampleUnits: 0, leadMs: null, autoMs: 0, waits: [], otherMs: 0 }
  }
  // Every unit's parts add up to its lead time; the means are split from the mean lead time the
  // same way, so the bar never comes out a millisecond longer or shorter than its total.
  const leadMs = Math.round(sum(timed.map((item) => item.time.leadMs)) / timed.length)
  const waitSums = PROCESS_GATE_KINDS.map((kind) =>
    sum(timed.map((item) => item.time.waits.find((wait) => wait.kind === kind)?.ms ?? 0)),
  )
  const [autoMs, otherMs, ...waitParts] = apportion(leadMs, [
    sum(timed.map((item) => item.time.autoMs ?? 0)),
    sum(timed.map((item) => item.time.otherMs ?? 0)),
    ...waitSums,
  ])
  return {
    sampleUnits: timed.length,
    leadMs,
    autoMs: autoMs!,
    waits: PROCESS_GATE_KINDS.map((kind, index) => ({ kind, ms: waitParts[index]! })).filter(
      (wait) => wait.ms > 0,
    ),
    otherMs: otherMs!,
  }
}

/** Waiting ÷ lead time over succeeded units. */
export function waitShareOf(numbers: readonly ProcessUnitNumbers[]): number | null {
  const succeeded = succeededOf(numbers)
  return ratio(
    sum(succeeded.map((item) => item.time.waitMs)),
    sum(succeeded.map((item) => item.time.leadMs)),
  )
}

/**
 * Mean tokens of a unit by cause group. The six groups always add up to the
 * mean tokens of a unit. Durations are a share of the summed node-run time:
 * parallel runs overlap, so absolute values would not add up to anything.
 */
export function causeSlicesOf(numbers: readonly ProcessUnitNumbers[]): ProcessCauseSlice[] {
  const sample = tokenSampleOf(numbers)
  const tokens = new Map<ProcessCauseGroup, { tokens: number; costNano: number }>()
  for (const item of sample) {
    for (const [cause, value] of item.causeTokens) {
      const group = PROCESS_CAUSE_GROUP_OF[cause]
      const previous = tokens.get(group)
      tokens.set(group, {
        tokens: (previous?.tokens ?? 0) + value.tokens,
        costNano: (previous?.costNano ?? 0) + value.costNano,
      })
    }
  }
  const active = new Map<ProcessCauseGroup, number>()
  for (const item of numbers) {
    for (const [cause, ms] of item.causeActiveMs) {
      const group = PROCESS_CAUSE_GROUP_OF[cause]
      active.set(group, (active.get(group) ?? 0) + ms)
    }
  }
  const activeTotal = sum([...active.values()])
  // Apportion the rounded means so the six groups add up to the headline number exactly.
  const groupTokens = PROCESS_CAUSE_GROUPS.map((cause) => tokens.get(cause)?.tokens ?? 0)
  const groupCost = PROCESS_CAUSE_GROUPS.map((cause) => tokens.get(cause)?.costNano ?? 0)
  const perUnit = (values: readonly number[]) =>
    apportion(sample.length ? Math.round(sum(values) / sample.length) : 0, values)
  const tokenParts = perUnit(groupTokens)
  const costParts = perUnit(groupCost)
  return PROCESS_CAUSE_GROUPS.map((cause, index) => ({
    cause,
    tokens: tokenParts[index]!,
    costNano: costParts[index]!,
    durationShare: ratio(active.get(cause) ?? 0, activeTotal),
  }))
}

export function interventionsOf(numbers: readonly ProcessUnitNumbers[]): ProcessInterventions {
  const ended = endedOf(numbers)
  const perUnit = (values: readonly number[]) => (ended.length ? sum(values) / ended.length : 0)
  return {
    gates: PROCESS_GATE_KINDS.map((kind) => ({
      kind,
      perUnit: perUnit(ended.map((item) => item.gateRounds.get(kind) ?? 0)),
    })).filter((gate) => gate.perUnit > 0),
    manualRetriesPerUnit: perUnit(ended.map((item) => item.facts.manualRetries)),
    operationsPerUnit: perUnit(ended.map((item) => item.operations)),
  }
}

export function stabilityOf(numbers: readonly ProcessUnitNumbers[]): ProcessStability {
  const codes = new Map<string, number>()
  for (const item of numbers) {
    for (const failure of item.facts.failureCodes) {
      codes.set(failure.code, (codes.get(failure.code) ?? 0) + failure.runs)
    }
  }
  return {
    failureCodes: [...codes]
      .map(([code, runs]) => ({ code, runs }))
      .sort((a, b) => b.runs - a.runs || a.code.localeCompare(b.code))
      .slice(0, 10),
    autoRetries: sum(numbers.map((item) => item.autoRetries)),
    interruptions: sum(numbers.map((item) => item.interruptedRuns)),
    recoveries: sum(numbers.map((item) => item.recoveries)),
    manualRetries: sum(numbers.map((item) => item.facts.manualRetries)),
    limitCancellations: numbers.filter((item) => item.facts.unit.limitCanceled).length,
    operations: sum(
      numbers.map(
        (item) =>
          item.facts.operations.filter((operation) => RECOVERY_ACTIONS.has(operation.action))
            .length,
      ),
    ),
  }
}

const WEEK_DAYS = 7
// Day index 0 is a Thursday; shifting by 3 makes weeks start on Monday.
const weekOfDay = (day: number) => Math.floor((day + 3) / WEEK_DAYS)
const firstDayOfWeek = (week: number) => week * WEEK_DAYS - 3

/** One point per calendar week touched by [from, to), by the unit's start time. */
export function trendOf(
  numbers: readonly ProcessUnitNumbers[],
  from: number,
  to: number,
  tzOffset: number,
): ProcessTrendPoint[] {
  const byWeek = new Map<number, ProcessUnitNumbers[]>()
  for (const item of numbers) {
    const week = weekOfDay(dayIndex(item.facts.unit.startedAt, tzOffset))
    const list = byWeek.get(week)
    if (list) list.push(item)
    else byWeek.set(week, [item])
  }
  const points: ProcessTrendPoint[] = []
  const last = weekOfDay(dayIndex(to - 1, tzOffset))
  for (let week = weekOfDay(dayIndex(from, tzOffset)); week <= last; week++) {
    const items = byWeek.get(week) ?? []
    const metrics = commonMetrics(items)
    points.push({
      week: dayLabel(firstDayOfWeek(week)),
      units: items.length,
      leadP50: metrics.leadP50 ?? null,
      tokensPerUnit: metrics.tokensPerUnit ?? null,
      firstPassRate: metrics.firstPassRate ?? null,
    })
  }
  return points
}

/** Per-kind extras the listing row of a unit carries. */
export interface ProcessUnitRowExtras {
  readonly rounds: number | null
  readonly assignments: number | null
  readonly completionRejections: number | null
  readonly capped: boolean
  readonly rework: readonly { readonly key: string; readonly rounds: number }[]
}

export const NO_ROW_EXTRAS: ProcessUnitRowExtras = {
  rounds: null,
  assignments: null,
  completionRejections: null,
  capped: false,
  rework: [],
}

export function unitRowOf(item: ProcessUnitNumbers, extras: ProcessUnitRowExtras): ProcessUnitRow {
  const { unit, usageTotals } = item.facts
  return {
    unitId: unit.id,
    taskId: unit.taskId,
    name: unit.name,
    status: unit.status,
    outcome: unit.outcome,
    origin: unit.origin,
    ownerUserId: unit.ownerUserId,
    revision: unit.subjectRevision,
    startedAt: unit.startedAt,
    endedAt: unit.endedAt,
    leadMs: item.time.leadMs,
    autoMs: item.time.autoMs,
    waits: item.time.waits,
    otherMs: item.time.otherMs,
    tokens: usageTotals.tokens,
    costNano: usageTotals.costNano,
    usageLowerBound: usageTotals.incompleteCalls > 0,
    unpriced: usageTotals.unpricedCalls > 0,
    gateRounds: PROCESS_GATE_KINDS.map((kind) => ({
      kind,
      rounds: item.gateRounds.get(kind) ?? 0,
    })).filter((gate) => gate.rounds > 0),
    autoRetries: item.autoRetries,
    manualRetries: item.facts.manualRetries,
    firstPass: item.firstPass,
    // Picked one by one: the kinds hand in richer extras than the row may carry.
    rounds: extras.rounds,
    assignments: extras.assignments,
    completionRejections: extras.completionRejections,
    capped: extras.capped,
    rework: extras.rework,
  }
}
