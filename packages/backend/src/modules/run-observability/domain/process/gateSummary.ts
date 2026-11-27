// RFC-616 §5.4–§5.6 — statistics of human gates.
//
// A gate statistic describes the gate, not the unit around it: every closed,
// non-void round counts whatever became of its unit. Void rounds (a review
// version superseded upstream or voided by a sibling's rejection, a canceled
// or abandoned clarify round) are counted separately and nowhere else — they
// record what the system did, not what a person decided. Their waiting time
// still belongs to the unit's time split (timeline.ts).

import type {
  ProcessAnswerMix,
  ProcessClarifySummary,
  ProcessDecisionGate,
  ProcessGateKind,
  ProcessMindmapSummary,
  ProcessOperationAction,
  ProcessPersonRow,
  ProcessReviewStageRow,
  ProcessReviewSummary,
} from '@agent-workflow/shared'
import type { ProcessGateMeasure } from '@/platform/contracts/processFacts'
import type { ProcessGateRound, ProcessOperation, ProcessUnitFacts } from './model'
import { mean, median, ratio, statOf, sum } from './stats'

interface PlacedRound {
  readonly unitId: string
  readonly gate: ProcessGateRound
  readonly operations: readonly ProcessOperation[]
}

function roundsOf(units: readonly ProcessUnitFacts[], kind: ProcessGateKind): PlacedRound[] {
  return units.flatMap((facts) =>
    facts.gates
      .filter((gate) => gate.kind === kind && gate.inherited !== true)
      .map((gate) => ({ unitId: facts.unit.id, gate, operations: facts.operations })),
  )
}

const isValid = (round: PlacedRound) => !round.gate.void
const isClosed = (round: PlacedRound) => round.gate.closedAt !== null
const durationOf = (round: PlacedRound) =>
  Math.max(0, (round.gate.closedAt ?? round.gate.openedAt) - round.gate.openedAt)
const measure = (round: PlacedRound, name: ProcessGateMeasure) => round.gate.measures[name] ?? 0
const total = (rounds: readonly PlacedRound[], name: ProcessGateMeasure) =>
  sum(rounds.map((round) => measure(round, name)))

/**
 * When the round was first opened by someone, from the recorded "view"
 * operations: the earliest session that overlaps the round. A session that
 * began before the round was ready counts from the moment it became ready.
 * null when nobody's view was recorded (always so before this feature shipped).
 */
export function firstOpenOf(
  gate: Pick<ProcessGateRound, 'subject' | 'openedAt' | 'closedAt'>,
  operations: readonly ProcessOperation[],
  action: ProcessOperationAction,
  userId?: string,
): number | null {
  if (gate.subject === null || gate.closedAt === null) return null
  let first: number | null = null
  for (const operation of operations) {
    if (operation.action !== action) continue
    if (operation.subjectKind !== gate.subject.kind || operation.subjectId !== gate.subject.id)
      continue
    if (userId !== undefined && operation.actorUserId !== userId) continue
    if (operation.lastAt < gate.openedAt || operation.firstAt > gate.closedAt) continue
    const at = Math.max(operation.firstAt, gate.openedAt)
    if (first === null || at < first) first = at
  }
  return first
}

function responseSplit(rounds: readonly PlacedRound[], action: ProcessOperationAction) {
  const response: number[] = []
  const handling: number[] = []
  for (const round of rounds) {
    const opened = firstOpenOf(round.gate, round.operations, action)
    if (opened === null) continue
    response.push(opened - round.gate.openedAt)
    handling.push(round.gate.closedAt! - opened)
  }
  return { responseMs: statOf(response), handlingMs: statOf(handling) }
}

function peopleOf(
  rounds: readonly PlacedRound[],
  action: ProcessOperationAction,
): ProcessPersonRow[] {
  const rows = new Map<
    string,
    { decisions: number; comments: number; answers: number; responses: number[] }
  >()
  const row = (userId: string) => {
    let entry = rows.get(userId)
    if (!entry) {
      entry = { decisions: 0, comments: 0, answers: 0, responses: [] }
      rows.set(userId, entry)
    }
    return entry
  }
  for (const round of rounds) {
    if (round.gate.deciderUserId !== null) row(round.gate.deciderUserId).decisions++
    const involved = new Set<string>()
    if (round.gate.deciderUserId !== null) involved.add(round.gate.deciderUserId)
    for (const person of round.gate.people) {
      const entry = row(person.userId)
      entry.comments += person.comments
      entry.answers += person.answers
      involved.add(person.userId)
    }
    for (const userId of involved) {
      const opened = firstOpenOf(round.gate, round.operations, action, userId)
      if (opened !== null) row(userId).responses.push(opened - round.gate.openedAt)
    }
  }
  return [...rows]
    .map(([userId, entry]) => ({
      userId,
      decisions: entry.decisions,
      comments: entry.comments,
      answers: entry.answers,
      responseP50: median(entry.responses),
    }))
    .sort(
      (a, b) =>
        b.decisions + b.comments + b.answers - (a.decisions + a.comments + a.answers) ||
        a.userId.localeCompare(b.userId),
    )
}

interface ReviewInstance {
  readonly stageKey: string
  readonly rounds: PlacedRound[]
}

function instancesOf(rounds: readonly PlacedRound[]): ReviewInstance[] {
  const grouped = new Map<string, ReviewInstance>()
  for (const round of rounds) {
    const key = `${round.unitId}\u0000${round.gate.instanceKey}`
    const instance = grouped.get(key)
    if (instance) instance.rounds.push(round)
    else grouped.set(key, { stageKey: round.gate.stageKey, rounds: [round] })
  }
  for (const instance of grouped.values()) {
    instance.rounds.sort((a, b) => a.gate.ordinal - b.gate.ordinal)
  }
  return [...grouped.values()]
}

/** Instances whose first valid round was approved ÷ instances whose first valid round is decided. */
function firstPassRateOf(instances: readonly ReviewInstance[]): number | null {
  const decided = instances
    .map((instance) => instance.rounds.find((round) => round.gate.ordinal === 1))
    .filter((round): round is PlacedRound => round !== undefined && isClosed(round))
  return ratio(decided.filter((round) => round.gate.outcome === 'approved').length, decided.length)
}

const distinctUnits = (rounds: readonly PlacedRound[]) =>
  new Set(rounds.map((round) => round.unitId)).size

export function reviewSummaryOf(
  units: readonly ProcessUnitFacts[],
  options: { readonly people: boolean },
): ProcessReviewSummary | null {
  const all = roundsOf(units, 'review')
  if (all.length === 0) return null
  const valid = all.filter(isValid)
  const closed = valid.filter(isClosed)
  const instances = instancesOf(valid)
  const withComments = closed.filter((round) => measure(round, 'comments') > 0)
  const rework: number[] = []
  for (const instance of instances) {
    for (let index = 0; index + 1 < instance.rounds.length; index++) {
      const sent = instance.rounds[index]!
      const next = instance.rounds[index + 1]!
      if (sent.gate.closedAt === null) continue
      if (sent.gate.outcome !== 'iterated' && sent.gate.outcome !== 'rejected') continue
      rework.push(Math.max(0, next.gate.openedAt - sent.gate.closedAt))
    }
  }
  const ordinals = new Map<number, { rounds: number; comments: number }>()
  for (const round of closed) {
    const entry = ordinals.get(round.gate.ordinal) ?? { rounds: 0, comments: 0 }
    entry.rounds++
    entry.comments += measure(round, 'comments')
    ordinals.set(round.gate.ordinal, entry)
  }
  const stages = [...new Set(valid.map((round) => round.gate.stageKey))]
  const byStage: ProcessReviewStageRow[] = stages.map((stageKey) => {
    const stageClosed = closed.filter((round) => round.gate.stageKey === stageKey)
    return {
      stageKey,
      relatedStageKey:
        valid.find((round) => round.gate.stageKey === stageKey && round.gate.relatedStageKey)?.gate
          .relatedStageKey ?? null,
      roundsPerUnit: ratio(stageClosed.length, distinctUnits(stageClosed)),
      durationMs: statOf(stageClosed.map(durationOf)),
      commentsPerRound: ratio(total(stageClosed, 'comments'), stageClosed.length),
      firstPassRate: firstPassRateOf(
        instances.filter((instance) => instance.stageKey === stageKey),
      ),
    }
  })
  const documents = total(closed, 'documents')
  return {
    rounds: closed.length,
    voidRounds: all.length - valid.length,
    durationMs: statOf(closed.map(durationOf)),
    ...responseSplit(closed, 'review.view'),
    roundsPerUnit: ratio(closed.length, distinctUnits(closed)),
    firstPassRate: firstPassRateOf(instances),
    commentsPerRound: ratio(total(closed, 'comments'), closed.length),
    commentsPerCommenter: mean(
      withComments
        .filter((round) => measure(round, 'commenters') > 0)
        .map((round) => measure(round, 'comments') / measure(round, 'commenters')),
    ),
    commentersPerRound: ratio(total(withComments, 'commenters'), withComments.length),
    reworkMs: statOf(rework),
    decisions: {
      approved: closed.filter((round) => round.gate.outcome === 'approved').length,
      iterated: closed.filter((round) => round.gate.outcome === 'iterated').length,
      rejected: closed.filter((round) => round.gate.outcome === 'rejected').length,
    },
    commentsByRound: [...ordinals]
      .map(([ordinal, entry]) => ({ ordinal, rounds: entry.rounds, comments: entry.comments }))
      .sort((a, b) => a.ordinal - b.ordinal),
    documentAcceptRate: ratio(total(closed, 'documentsAccepted'), documents),
    byStage,
    people: options.people ? peopleOf(closed, 'review.view') : null,
  }
}

function answerMixOf(rounds: readonly PlacedRound[]): ProcessAnswerMix {
  return {
    recommended: total(rounds, 'answersRecommended'),
    other: total(rounds, 'answersOther'),
    custom: total(rounds, 'answersCustom'),
    skipped: total(rounds, 'answersSkipped'),
  }
}

export function clarifySummaryOf(
  units: readonly ProcessUnitFacts[],
  options: { readonly people: boolean },
): ProcessClarifySummary | null {
  const all = roundsOf(units, 'clarify')
  if (all.length === 0) return null
  const answered = all.filter((round) => isValid(round) && isClosed(round))
  const stages = [...new Set(answered.map((round) => round.gate.stageKey))]
  return {
    rounds: answered.length,
    voidRounds: all.filter((round) => !isValid(round)).length,
    triggerRate: ratio(distinctUnits(all), units.length),
    unitsAsking: distinctUnits(all),
    roundsPerUnit: ratio(answered.length, distinctUnits(answered)),
    questionsPerRound: ratio(total(answered, 'questions'), answered.length),
    answerMs: statOf(answered.map(durationOf)),
    ...responseSplit(answered, 'clarify.view'),
    stopRate: ratio(
      answered.filter((round) => round.gate.outcome === 'stop').length,
      answered.length,
    ),
    answers: answerMixOf(answered),
    answersWithRecommendation: total(answered, 'questionsWithRecommendation'),
    recommendedRate: ratio(
      total(answered, 'answersRecommended'),
      total(answered, 'questionsWithRecommendation'),
    ),
    byStage: stages.map((stageKey) => {
      const stageRounds = answered.filter((round) => round.gate.stageKey === stageKey)
      return {
        stageKey,
        askingStageKey:
          stageRounds.find((round) => round.gate.relatedStageKey)?.gate.relatedStageKey ?? null,
        roundsPerUnit: ratio(stageRounds.length, distinctUnits(stageRounds)),
      }
    }),
    people: options.people ? peopleOf(answered, 'clarify.view') : null,
  }
}

export function mindmapSummaryOf(
  units: readonly ProcessUnitFacts[],
  options: {
    /** Follow-up generation calls: duration and tokens of each. */
    readonly followups: readonly { readonly durationMs: number | null; readonly tokens: number }[]
    /** Top-level categories configured per clarify stage, by name. */
    readonly categories: ReadonlyMap<string, ReadonlySet<string>>
  },
): ProcessMindmapSummary | null {
  const maps = roundsOf(units, 'clarify').filter(
    (round) => round.gate.mindmap && isValid(round) && isClosed(round),
  )
  if (maps.length === 0) return null
  const questions = total(maps, 'questions')
  const askers = new Set(maps.map((round) => `${round.unitId}\u0000${round.gate.instanceKey}`))
  // A category counts as covered when a question falls under one the node configures; a
  // question filed under any other name covers nothing.
  const configured = maps.flatMap((round) => {
    const names = options.categories.get(round.gate.stageKey)
    if (names === undefined || names.size === 0) return []
    const covered = new Set((round.gate.categories ?? []).filter((name) => names.has(name)))
    return [{ configured: names.size, covered: covered.size }]
  })
  const timed = options.followups
    .map((call) => call.durationMs)
    .filter((value): value is number => value !== null)
  const generationMs = mean(timed)
  const generationTokens = mean(options.followups.map((call) => call.tokens))
  return {
    maps: maps.length,
    depthMean: ratio(total(maps, 'depthSum'), questions),
    depthMax: maps.reduce<number | null>((max, round) => {
      const depth = round.gate.measures.depthMax
      return depth === undefined ? max : max === null ? depth : Math.max(max, depth)
    }, null),
    mapsPerNode: ratio(maps.length, askers.size),
    followupsPerMap: ratio(total(maps, 'followupRequests'), maps.length),
    questionsPerMap: ratio(questions, maps.length),
    initialQuestionsPerMap: ratio(total(maps, 'questionsInitial'), maps.length),
    followupQuestionsPerMap: ratio(total(maps, 'questionsFollowup'), maps.length),
    durationMs: statOf(maps.map(durationOf)),
    followupGenerationMs: generationMs === null ? null : Math.round(generationMs),
    followupGenerationTokens: generationTokens === null ? null : Math.round(generationTokens),
    maturity: {
      decided: total(maps, 'maturityDecided'),
      provisional: total(maps, 'maturityProvisional'),
      unmarked: total(maps, 'maturityUnmarked'),
      skipped: total(maps, 'answersSkipped'),
    },
    categoryCoverage: ratio(
      sum(configured.map((entry) => entry.covered)),
      sum(configured.map((entry) => entry.configured)),
    ),
  }
}

/** A yes/no gate (completion, plan confirmation): waits, rejections and what a rejection cost. */
export function decisionGateOf(
  units: readonly ProcessUnitFacts[],
  kind: ProcessGateKind,
): ProcessDecisionGate | null {
  const all = roundsOf(units, kind)
  if (all.length === 0) return null
  const closed = all.filter((round) => isValid(round) && isClosed(round))
  const rejected = closed.filter((round) => round.gate.outcome === 'rejected')
  const extra: number[] = []
  for (const facts of units) {
    const gates = facts.gates
      .filter((gate) => gate.kind === kind && !gate.void && gate.inherited !== true)
      .sort((a, b) => a.openedAt - b.openedAt)
    for (let index = 0; index + 1 < gates.length; index++) {
      const before = gates[index]!
      const after = gates[index + 1]!
      if (before.outcome !== 'rejected') continue
      if (before.round == null || after.round == null) continue
      extra.push(Math.max(0, after.round - before.round))
    }
  }
  return {
    rounds: closed.length,
    waitMs: statOf(closed.map(durationOf)),
    rejections: rejected.length,
    rejectRate: ratio(rejected.length, closed.length),
    extraRoundsAfterReject: mean(extra),
  }
}

/** Closed, non-void spans of one gate kind as a duration sample. */
export function gateDurationsOf(
  units: readonly ProcessUnitFacts[],
  kind: ProcessGateKind,
): number[] {
  return roundsOf(units, kind)
    .filter((round) => isValid(round) && isClosed(round))
    .map(durationOf)
}
