// RFC-616 §5.3 — one row per stage across the units of a subject.
//
// Sampling follows unitSummary.ts: durations over succeeded units, tokens over
// ended units with usage records, execution rates over every unit. A wrapper
// stage shows its own start-to-finish time; its inner stages are separate rows
// and are never added to it.

import type { ProcessLoopFacts, ProcessStageRow } from '@agent-workflow/shared'
import { unitEnded, type ProcessStage } from './model'
import { gateSpan, unionLength } from './timeline'
import { ratio, statOf, sum } from './stats'
import type { ProcessUnitNumbers } from './unitSummary'

export interface StageTotals {
  unitsRun: number
  runs: number
  endedRuns: number
  failedRuns: number
  autoRetryRuns: number
  /** Per succeeded unit: the stage's summed execution time. */
  durations: number[]
  tokenUnits: number
  tokens: number
  costNano: number
  reworkTokens: number
  failureCodes: Map<string, number>
  reviewDecided: number
  reviewSentBack: number
  unitsAsking: number
  gateUnits: number
  gateRounds: number
  /** Succeeded units that waited at a gate held here, and their summed waiting time. */
  gateWaitUnits: number
  gateWaitMs: number
  firstRoundDecided: number
  firstRoundApproved: number
  units: number
}

function emptyTotals(): StageTotals {
  return {
    unitsRun: 0,
    runs: 0,
    endedRuns: 0,
    failedRuns: 0,
    autoRetryRuns: 0,
    durations: [],
    tokenUnits: 0,
    tokens: 0,
    costNano: 0,
    reworkTokens: 0,
    failureCodes: new Map(),
    reviewDecided: 0,
    reviewSentBack: 0,
    unitsAsking: 0,
    gateUnits: 0,
    gateRounds: 0,
    gateWaitUnits: 0,
    gateWaitMs: 0,
    firstRoundDecided: 0,
    firstRoundApproved: 0,
    units: 0,
  }
}

/** Raw per-stage totals; the hint rules read these, the stage rows are derived from them. */
export function stageTotalsOf(numbers: readonly ProcessUnitNumbers[], now: number) {
  const totals = new Map<string, StageTotals>()
  const of = (key: string) => {
    let entry = totals.get(key)
    if (!entry) {
      entry = emptyTotals()
      totals.set(key, entry)
    }
    return entry
  }
  let allTokens = 0
  for (const item of numbers) {
    const { facts } = item
    const succeeded = facts.unit.status === 'succeeded'
    const touched = new Set<string>()

    const runsByStage = new Map<string, { runs: number; activeMs: number }>()
    for (const execution of facts.executions) {
      const entry = of(execution.stageKey)
      entry.runs += execution.runs
      entry.endedRuns += execution.endedRuns
      entry.failedRuns += execution.failedRuns
      if (execution.cause === 'auto-retry') entry.autoRetryRuns += execution.runs
      const stage = runsByStage.get(execution.stageKey) ?? { runs: 0, activeMs: 0 }
      stage.runs += execution.runs
      stage.activeMs += execution.activeMs
      runsByStage.set(execution.stageKey, stage)
    }
    // A wrapper's time is its own invocation span, not the sum of what ran inside it.
    const wrapperMs = new Map<string, number>()
    for (const wrapper of facts.wrappers) {
      if (wrapper.durationMs === null) continue
      wrapperMs.set(wrapper.stageKey, (wrapperMs.get(wrapper.stageKey) ?? 0) + wrapper.durationMs)
    }
    for (const [stageKey, stage] of runsByStage) {
      if (stage.runs === 0) continue
      const entry = of(stageKey)
      entry.unitsRun++
      touched.add(stageKey)
      if (succeeded && !wrapperMs.has(stageKey)) entry.durations.push(stage.activeMs)
    }
    for (const [stageKey, ms] of wrapperMs) {
      touched.add(stageKey)
      if (succeeded) of(stageKey).durations.push(ms)
    }
    for (const failure of facts.failureCodes) {
      const codes = of(failure.stageKey).failureCodes
      codes.set(failure.code, (codes.get(failure.code) ?? 0) + failure.runs)
    }

    if (item.tokenSample) {
      const tokenStages = new Set<string>()
      for (const slice of facts.usage) {
        const entry = of(slice.stageKey)
        entry.tokens += slice.tokens
        entry.costNano += slice.costNano
        if (slice.cause === 'review-rework') entry.reworkTokens += slice.tokens
        allTokens += slice.tokens
        tokenStages.add(slice.stageKey)
      }
      // A stage that ran without calling a model still belongs to the token sample, with zero.
      for (const stageKey of new Set([...tokenStages, ...runsByStage.keys()])) {
        of(stageKey).tokenUnits++
      }
    }

    const start = facts.unit.startedAt
    const end = Math.max(start, facts.unit.endedAt ?? now)
    const gateStages = new Map<string, { rounds: number; spans: { from: number; to: number }[] }>()
    const asking = new Set<string>()
    for (const gate of facts.gates) {
      const held = gateStages.get(gate.stageKey) ?? { rounds: 0, spans: [] }
      const span = gateSpan(gate, start, end)
      if (span !== null) held.spans.push(span)
      if (!gate.void && gate.closedAt !== null) held.rounds++
      gateStages.set(gate.stageKey, held)
      if (gate.relatedStageKey === null) continue
      if (gate.kind === 'clarify') asking.add(gate.relatedStageKey)
      if (gate.kind !== 'review' || gate.void || gate.closedAt === null) continue
      const reviewed = of(gate.relatedStageKey)
      reviewed.reviewDecided++
      if (gate.outcome === 'iterated' || gate.outcome === 'rejected') reviewed.reviewSentBack++
    }
    for (const stageKey of asking) of(stageKey).unitsAsking++
    for (const [stageKey, held] of gateStages) {
      const entry = of(stageKey)
      entry.gateUnits++
      entry.gateRounds += held.rounds
      // Waiting is a duration: like every duration it is read from succeeded units only, so a
      // gate still open in a running unit does not grow the number while the page is watched.
      if (succeeded) {
        entry.gateWaitUnits++
        entry.gateWaitMs += unionLength(held.spans)
      }
      touched.add(stageKey)
    }
    const firstRounds = new Map<string, string | null>()
    for (const gate of facts.gates) {
      if (gate.kind !== 'review' || gate.ordinal !== 1 || gate.closedAt === null) continue
      if (gate.inherited === true) continue
      firstRounds.set(`${gate.stageKey}\u0000${gate.instanceKey}`, gate.outcome)
    }
    for (const [key, outcome] of firstRounds) {
      const entry = of(key.slice(0, key.indexOf('\u0000')))
      entry.firstRoundDecided++
      if (outcome === 'approved') entry.firstRoundApproved++
    }

    for (const stageKey of touched) of(stageKey).units++
  }
  return { totals, allTokens }
}

function loopFactsOf(
  numbers: readonly ProcessUnitNumbers[],
  stageKey: string,
  settings: { readonly maxIterations: number | null; readonly continuesAtCap: boolean } | undefined,
): ProcessLoopFacts | null {
  const runs = numbers
    .filter((item) => unitEnded(item.facts.unit))
    .flatMap((item) => item.facts.wrappers.filter((wrapper) => wrapper.stageKey === stageKey))
  if (runs.length === 0 && settings === undefined) return null
  const max = settings?.maxIterations ?? null
  const continuesAtCap = settings?.continuesAtCap ?? false
  // A loop that continues after the cap ends `done` either way: "ran every round" is all we can see.
  const capped = runs.filter(
    (run) => run.status === 'exhausted' || (continuesAtCap && max !== null && run.rounds >= max),
  )
  return {
    roundsMean: ratio(sum(runs.map((run) => run.rounds)), runs.length),
    roundsMax: runs.length ? Math.max(...runs.map((run) => run.rounds)) : null,
    maxIterations: max,
    capRate: ratio(capped.length, runs.length),
    capIncludesFullRuns: continuesAtCap,
  }
}

export interface StageRowsInput {
  readonly stages: readonly ProcessStage[]
  readonly numbers: readonly ProcessUnitNumbers[]
  readonly loops?: ReadonlyMap<
    string,
    { readonly maxIterations: number | null; readonly continuesAtCap: boolean }
  >
  /** Units of the comparison baseline; null when comparison is off. */
  readonly baseline?: readonly ProcessUnitNumbers[] | null
  readonly now: number
}

export function stageRowsOf(input: StageRowsInput): ProcessStageRow[] {
  const { totals, allTokens } = stageTotalsOf(input.numbers, input.now)
  const baseline = input.baseline == null ? null : stageTotalsOf(input.baseline, input.now).totals
  return [...input.stages]
    .sort((a, b) => a.order - b.order)
    .map((stage): ProcessStageRow => {
      const entry = totals.get(stage.key) ?? emptyTotals()
      const [topCode, topRuns] = [...entry.failureCodes].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0] ?? [null, 0]
      const fanoutRuns =
        stage.kind === 'wrapper-fanout'
          ? input.numbers.flatMap((item) =>
              item.facts.wrappers.filter((wrapper) => wrapper.stageKey === stage.key),
            )
          : []
      const base = baseline?.get(stage.key)
      return {
        key: stage.key,
        label: stage.label,
        kind: stage.kind,
        parentKey: stage.parentKey,
        order: stage.order,
        removed: stage.removed,
        units: entry.units,
        runsPerUnit: ratio(entry.runs, entry.unitsRun),
        durationMs: statOf(entry.durations),
        tokensPerUnit: entry.tokenUnits > 0 ? Math.round(entry.tokens / entry.tokenUnits) : null,
        costNanoPerUnit:
          entry.tokenUnits > 0 ? Math.round(entry.costNano / entry.tokenUnits) : null,
        tokenShare: entry.tokenUnits > 0 ? ratio(entry.tokens, allTokens) : null,
        failureRate: ratio(entry.failedRuns, entry.endedRuns),
        autoRetryRate: ratio(entry.autoRetryRuns, entry.runs),
        topFailureCode: topCode,
        topFailureShare: ratio(topRuns, sum([...entry.failureCodes.values()])),
        rejectRate: ratio(entry.reviewSentBack, entry.reviewDecided),
        // A stage that ran and never asked asked in 0% of its units; null is for "never ran".
        clarifyRate: ratio(entry.unitsAsking, entry.unitsRun),
        reworkTokenShare: ratio(entry.reworkTokens, entry.tokens),
        gateRoundsPerUnit: ratio(entry.gateRounds, entry.gateUnits),
        gateWaitMsPerUnit:
          entry.gateWaitUnits > 0 ? Math.round(entry.gateWaitMs / entry.gateWaitUnits) : null,
        gateFirstPassRate: ratio(entry.firstRoundApproved, entry.firstRoundDecided),
        loop:
          stage.kind === 'wrapper-loop'
            ? loopFactsOf(input.numbers, stage.key, input.loops?.get(stage.key))
            : null,
        fanout:
          stage.kind === 'wrapper-fanout'
            ? {
                shardsMean: ratio(sum(fanoutRuns.map((run) => run.shards)), fanoutRuns.length),
                shardFailureRate: ratio(
                  fanoutRuns.filter((run) => run.status === 'failed' && run.shards > 0).length,
                  fanoutRuns.filter((run) => run.shards > 0).length,
                ),
              }
            : null,
        baseline:
          baseline === null
            ? null
            : {
                durationP50: base ? statOf(base.durations).p50 : null,
                tokensPerUnit:
                  base && base.tokenUnits > 0 ? Math.round(base.tokens / base.tokenUnits) : null,
              },
      }
    })
}
