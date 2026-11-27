// RFC-616 §8 — improvement hints computed from the metrics by fixed rules.
// No model is involved. The thresholds are the product's first version and are
// not configurable; they live here, in one table, so a change is one edit.
//
// A rule that looks at stages reports its worst stage only, so a subject with
// twenty noisy nodes still gets one line per kind of problem.
//
// A minimum sample is always checked on what the rate is a share of: a loop's
// cap rate on its invocations, a work item's rounds on the cases that ran it,
// the first-pass rate on the units it was judged for. "Five units" where one
// of them reached the loop is a sample of one.

import {
  PROCESS_HINT_IDS,
  type ProcessGateKind,
  type ProcessHint,
  type ProcessHintId,
  type ProcessHintSeverity,
  type ProcessHintTarget,
  type ProcessSubjectKind,
} from '@agent-workflow/shared'

const HOUR = 3_600_000

export const HINT_THRESHOLDS = {
  minSucceededUnits: 5,
  minUnits: 5,
  waitShare: 0.5,
  waitShareHigh: 0.6,
  gateMinRounds: 5,
  gateP50Ms: 4 * HOUR,
  gateP90Ms: 24 * HOUR,
  gateP50HighMs: 8 * HOUR,
  gateP90HighMs: 48 * HOUR,
  rejectRate: 0.4,
  rejectRateHigh: 0.6,
  rejectMinRounds: 5,
  reworkTokenShare: 0.25,
  reworkTokenShareMid: 0.4,
  clarifyMinAnswers: 10,
  recommendedRate: 0.5,
  customRate: 0.3,
  loopCapRate: 0.1,
  loopCapRateHigh: 0.25,
  autoRetryRate: 0.15,
  autoRetryRateHigh: 0.3,
  autoRetryMinRuns: 10,
  firstPassRate: 0.3,
  firstPassRateHigh: 0.15,
  coordinationShare: 0.2,
  completionRejectRate: 0.15,
  completionRejectRateHigh: 0.3,
  completionMinRounds: 5,
  deliveryP50Ms: HOUR,
  deliveryWaitShare: 0.15,
  blockedRate: 0.2,
  blockedRateHigh: 0.4,
  workItemRounds: 2,
  workItemRoundsHigh: 2.5,
} as const

/** What the rules read. Each subject kind fills what it has; the rest stays null or empty. */
export interface HintFacts {
  readonly kind: ProcessSubjectKind
  readonly units: number
  readonly succeededUnits: number
  /** Waiting ÷ lead time of succeeded units, and the gate kind that waits longest. */
  readonly waitShare: number | null
  readonly topWaitKind: ProcessGateKind | null
  readonly topWaitShare: number | null
  readonly gates: readonly {
    readonly kind: ProcessGateKind
    readonly rounds: number
    readonly p50: number | null
    readonly p90: number | null
  }[]
  readonly stages: readonly {
    readonly key: string
    /** Units in which the stage ran or held a gate. */
    readonly units: number
    readonly runs: number
    readonly autoRetryRate: number | null
    readonly topFailureCode: string | null
    readonly topFailureShare: number | null
    readonly rejectRate: number | null
    readonly reviewRounds: number
    /** Loop stages: invocations in ended units, and the share of them that hit the cap. */
    readonly loopRuns: number
    readonly loopCapRate: number | null
    readonly loopRoundsMean: number | null
    /** Digital employee work items: rounds per case. */
    readonly roundsPerUnit: number | null
    readonly failureRate: number | null
  }[]
  /** Review rework tokens ÷ all tokens, and the mean rework tokens and cost of a unit. */
  readonly reworkTokenShare: number | null
  readonly reworkTokens: number
  readonly reworkCostNano: number
  readonly clarify: {
    readonly answered: number
    /** Answers to questions that offered a recommendation: what the recommended rate is a share of. */
    readonly recommendable: number
    readonly recommendedRate: number | null
    readonly customRate: number | null
  } | null
  readonly firstPassRate: number | null
  /** Units whose first pass was judged: what the rate is a share of. */
  readonly firstPassUnits: number
  readonly coordinationShare: number | null
  readonly completion: {
    readonly rounds: number
    readonly rejectRate: number | null
    readonly extraRounds: number | null
  } | null
  readonly delivery: { readonly p50: number | null; readonly waitShare: number | null } | null
  readonly blocked: {
    readonly rate: number | null
    readonly p50: number | null
    readonly current: number
  } | null
}

type Finding = {
  readonly severity: ProcessHintSeverity
  readonly target: ProcessHintTarget
  readonly params: Readonly<Record<string, string | number | null>>
} | null

const escalate = (high: boolean, base: ProcessHintSeverity = 'mid'): ProcessHintSeverity =>
  high ? 'high' : base

/** The entry with the largest value among those that qualify. */
function worst<T>(items: readonly T[], value: (item: T) => number | null): T | null {
  let best: T | null = null
  let bestValue = -Infinity
  for (const item of items) {
    const current = value(item)
    if (current !== null && current > bestValue) {
      best = item
      bestValue = current
    }
  }
  return best
}

const T = HINT_THRESHOLDS

const RULES = {
  'wait-dominant': (facts) => {
    if (facts.succeededUnits < T.minSucceededUnits || facts.waitShare === null) return null
    if (facts.waitShare < T.waitShare) return null
    return {
      severity: escalate(facts.waitShare >= T.waitShareHigh),
      target: 'gates',
      params: {
        share: facts.waitShare,
        gate: facts.topWaitKind,
        gateShare: facts.topWaitShare,
      },
    }
  },
  'gate-slow': (facts) => {
    const slow = worst(
      facts.gates.filter(
        (gate) =>
          gate.rounds >= T.gateMinRounds &&
          ((gate.p50 ?? 0) >= T.gateP50Ms || (gate.p90 ?? 0) >= T.gateP90Ms),
      ),
      (gate) => gate.p50,
    )
    if (slow === null) return null
    return {
      severity: escalate((slow.p50 ?? 0) >= T.gateP50HighMs || (slow.p90 ?? 0) >= T.gateP90HighMs),
      target: 'gates',
      params: { gate: slow.kind, p50: slow.p50, p90: slow.p90, rounds: slow.rounds },
    }
  },
  'output-rejected': (facts) => {
    if (facts.kind === 'workgroup') return null
    const stage = worst(
      facts.stages.filter(
        (item) => item.reviewRounds >= T.rejectMinRounds && (item.rejectRate ?? 0) >= T.rejectRate,
      ),
      (item) => item.rejectRate,
    )
    if (stage === null) return null
    return {
      severity: escalate((stage.rejectRate ?? 0) >= T.rejectRateHigh),
      target: 'stages',
      params: { stageKey: stage.key, rate: stage.rejectRate, rounds: stage.reviewRounds },
    }
  },
  'rework-cost': (facts) => {
    if (facts.kind !== 'workflow' || facts.reworkTokenShare === null) return null
    if (facts.reworkTokenShare < T.reworkTokenShare) return null
    return {
      severity: facts.reworkTokenShare >= T.reworkTokenShareMid ? 'mid' : 'info',
      target: 'overview',
      params: {
        share: facts.reworkTokenShare,
        tokens: facts.reworkTokens,
        costNano: facts.reworkCostNano,
      },
    }
  },
  'clarify-mostly-recommended': (facts) => {
    const clarify = facts.clarify
    if (clarify === null || clarify.recommendable < T.clarifyMinAnswers) return null
    if ((clarify.recommendedRate ?? 0) < T.recommendedRate) return null
    return {
      severity: 'mid',
      target: 'gates',
      params: { rate: clarify.recommendedRate, answered: clarify.recommendable },
    }
  },
  'options-unfit': (facts) => {
    const clarify = facts.clarify
    if (clarify === null || clarify.answered < T.clarifyMinAnswers) return null
    if ((clarify.customRate ?? 0) < T.customRate) return null
    return {
      severity: 'mid',
      target: 'gates',
      params: { rate: clarify.customRate, answered: clarify.answered },
    }
  },
  'loop-capped': (facts) => {
    if (facts.kind !== 'workflow' || facts.units < T.minUnits) return null
    const stage = worst(
      facts.stages.filter(
        (item) => item.loopRuns >= T.minUnits && (item.loopCapRate ?? 0) >= T.loopCapRate,
      ),
      (item) => item.loopCapRate,
    )
    if (stage === null) return null
    return {
      severity: escalate((stage.loopCapRate ?? 0) >= T.loopCapRateHigh),
      target: 'stages',
      params: { stageKey: stage.key, rate: stage.loopCapRate, rounds: stage.loopRoundsMean },
    }
  },
  'auto-retry-high': (facts) => {
    const stage = worst(
      facts.stages.filter(
        (item) => item.runs >= T.autoRetryMinRuns && (item.autoRetryRate ?? 0) >= T.autoRetryRate,
      ),
      (item) => item.autoRetryRate,
    )
    if (stage === null) return null
    return {
      severity: escalate((stage.autoRetryRate ?? 0) >= T.autoRetryRateHigh),
      target: facts.kind === 'workgroup' ? 'members' : 'stages',
      params: {
        stageKey: stage.key,
        rate: stage.autoRetryRate,
        code: stage.topFailureCode,
        codeShare: stage.topFailureShare,
      },
    }
  },
  'first-pass-low': (facts) => {
    if (facts.firstPassUnits < T.minSucceededUnits || facts.firstPassRate === null) return null
    if (facts.firstPassRate > T.firstPassRate) return null
    return {
      severity: escalate(facts.firstPassRate <= T.firstPassRateHigh),
      target: 'overview',
      params: { rate: facts.firstPassRate, units: facts.firstPassUnits },
    }
  },
  'coordination-high': (facts) => {
    if (facts.kind !== 'workgroup' || facts.units < T.minUnits) return null
    if ((facts.coordinationShare ?? 0) < T.coordinationShare) return null
    return {
      severity: 'high',
      target: 'rounds',
      params: { share: facts.coordinationShare },
    }
  },
  'completion-rejected': (facts) => {
    const completion = facts.completion
    if (facts.kind !== 'workgroup' || completion === null) return null
    if (completion.rounds < T.completionMinRounds) return null
    if ((completion.rejectRate ?? 0) < T.completionRejectRate) return null
    return {
      severity: escalate((completion.rejectRate ?? 0) >= T.completionRejectRateHigh),
      target: 'gates',
      params: {
        rate: completion.rejectRate,
        rounds: completion.rounds,
        extraRounds: completion.extraRounds,
      },
    }
  },
  'human-delivery-slow': (facts) => {
    const delivery = facts.delivery
    if (facts.kind !== 'workgroup' || delivery === null) return null
    if ((delivery.p50 ?? 0) < T.deliveryP50Ms) return null
    if ((delivery.waitShare ?? 0) < T.deliveryWaitShare) return null
    return {
      severity: 'mid',
      target: 'members',
      params: { p50: delivery.p50, share: delivery.waitShare },
    }
  },
  'blocked-high': (facts) => {
    const blocked = facts.blocked
    if (facts.kind !== 'digital-employee' || blocked === null) return null
    if (facts.units < T.minUnits || (blocked.rate ?? 0) < T.blockedRate) return null
    return {
      severity: escalate((blocked.rate ?? 0) >= T.blockedRateHigh),
      target: 'gates',
      params: { rate: blocked.rate, p50: blocked.p50, current: blocked.current },
    }
  },
  'work-item-repeated': (facts) => {
    if (facts.kind !== 'digital-employee' || facts.units < T.minUnits) return null
    const stage = worst(
      facts.stages.filter(
        (item) => item.units >= T.minUnits && (item.roundsPerUnit ?? 0) >= T.workItemRounds,
      ),
      (item) => item.roundsPerUnit,
    )
    if (stage === null) return null
    return {
      severity: escalate((stage.roundsPerUnit ?? 0) >= T.workItemRoundsHigh),
      target: 'stages',
      params: {
        stageKey: stage.key,
        rounds: stage.roundsPerUnit,
        failureRate: stage.failureRate,
      },
    }
  },
} as const satisfies Record<ProcessHintId, (facts: HintFacts) => Finding>

const SEVERITY_ORDER: Readonly<Record<ProcessHintSeverity, number>> = { high: 0, mid: 1, info: 2 }

/** Every rule that fires, most severe first; rules keep their table order within a severity. */
export function hintsOf(facts: HintFacts): ProcessHint[] {
  const hints: ProcessHint[] = []
  for (const id of PROCESS_HINT_IDS) {
    const finding = RULES[id](facts)
    if (finding !== null) hints.push({ id, ...finding })
  }
  return hints.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}
