// RFC-616 §8 / §9 — improvement hints and text themes (pure functions).
//
// Hints: every rule fires exactly at its threshold and stays silent just below
// it or without enough samples; a rule that reads stages reports its worst one.
// Themes: every count, share and excerpt comes from the items themselves — a
// model's answer can only say which ids belong together.
import { describe, expect, test } from 'bun:test'
import {
  PROCESS_HINT_IDS,
  PROCESS_INSIGHT_ITEM_CHARS,
  PROCESS_INSIGHT_MAX_ITEMS,
} from '@agent-workflow/shared'
import {
  HINT_THRESHOLDS as T,
  hintsOf,
  type HintFacts,
} from '@/modules/run-observability/domain/process/hints'
import {
  buildInsightPrompt,
  extractJsonObject,
  groupThemes,
  prepareInsightItems,
  type InsightSourceItem,
} from '@/modules/run-observability/domain/process/themes'

const H = 3_600_000

function base(over: Partial<HintFacts> = {}): HintFacts {
  return {
    kind: 'workflow',
    units: 20,
    succeededUnits: 20,
    waitShare: null,
    topWaitKind: null,
    topWaitShare: null,
    gates: [],
    stages: [],
    reworkTokenShare: null,
    reworkTokens: 0,
    reworkCostNano: 0,
    clarify: null,
    firstPassRate: null,
    firstPassUnits: 20,
    coordinationShare: null,
    completion: null,
    delivery: null,
    blocked: null,
    ...over,
  }
}

function stage(over: Partial<HintFacts['stages'][number]> = {}): HintFacts['stages'][number] {
  return {
    key: 'code',
    units: 20,
    runs: 100,
    autoRetryRate: null,
    topFailureCode: null,
    topFailureShare: null,
    rejectRate: null,
    reviewRounds: 0,
    loopRuns: 0,
    loopCapRate: null,
    loopRoundsMean: null,
    roundsPerUnit: null,
    failureRate: null,
    ...over,
  }
}

const ids = (facts: HintFacts) => hintsOf(facts).map((hint) => hint.id)
const one = (facts: HintFacts, id: string) => hintsOf(facts).find((hint) => hint.id === id)

describe('RFC-616 hint rules', () => {
  test('nothing fires on an unremarkable subject', () => {
    expect(hintsOf(base())).toEqual([])
  })

  test('wait-dominant: at 50%, with at least five succeeded units', () => {
    expect(ids(base({ waitShare: T.waitShare - 0.01 }))).toEqual([])
    expect(ids(base({ waitShare: T.waitShare, succeededUnits: 4 }))).toEqual([])
    const hint = one(
      base({ waitShare: 0.5, topWaitKind: 'review', topWaitShare: 0.4 }),
      'wait-dominant',
    )!
    expect(hint).toMatchObject({
      severity: 'mid',
      target: 'gates',
      params: { share: 0.5, gate: 'review', gateShare: 0.4 },
    })
    expect(one(base({ waitShare: T.waitShareHigh }), 'wait-dominant')!.severity).toBe('high')
  })

  test('gate-slow: a median of four hours or a P90 of a day, over at least five rounds', () => {
    const gate = (p50: number, p90: number, rounds = 5) => [
      { kind: 'review' as const, rounds, p50, p90 },
    ]
    expect(ids(base({ gates: gate(4 * H - 1, 24 * H - 1) }))).toEqual([])
    expect(ids(base({ gates: gate(4 * H, 0, 4) }))).toEqual([])
    expect(one(base({ gates: gate(4 * H, 0) }), 'gate-slow')).toMatchObject({ severity: 'mid' })
    expect(one(base({ gates: gate(0, 24 * H) }), 'gate-slow')).toMatchObject({ severity: 'mid' })
    expect(one(base({ gates: gate(8 * H, 0) }), 'gate-slow')!.severity).toBe('high')
    expect(one(base({ gates: gate(0, 48 * H) }), 'gate-slow')!.severity).toBe('high')
    // The slowest gate kind is the one reported.
    const slowest = one(
      base({
        gates: [
          { kind: 'review', rounds: 9, p50: 5 * H, p90: 6 * H },
          { kind: 'clarify', rounds: 9, p50: 7 * H, p90: 9 * H },
        ],
      }),
      'gate-slow',
    )!
    expect(slowest.params).toMatchObject({ gate: 'clarify', p50: 7 * H, rounds: 9 })
  })

  test('output-rejected: 40% over at least five review rounds; never for a workgroup', () => {
    const facts = (rejectRate: number, reviewRounds = 5, kind: HintFacts['kind'] = 'workflow') =>
      base({ kind, stages: [stage({ key: 'design', rejectRate, reviewRounds })] })
    expect(ids(facts(0.39))).toEqual([])
    expect(ids(facts(0.4, 4))).toEqual([])
    expect(ids(facts(0.9, 9, 'workgroup'))).toEqual([])
    expect(one(facts(0.4), 'output-rejected')).toMatchObject({
      severity: 'mid',
      target: 'stages',
      params: { stageKey: 'design', rate: 0.4, rounds: 5 },
    })
    expect(one(facts(0.6), 'output-rejected')!.severity).toBe('high')
    expect(one(facts(0.6, 9, 'digital-employee'), 'output-rejected')).toBeDefined()
    // The worst stage is the one reported.
    const worst = one(
      base({
        stages: [
          stage({ key: 'a', rejectRate: 0.45, reviewRounds: 9 }),
          stage({ key: 'b', rejectRate: 0.7, reviewRounds: 9 }),
        ],
      }),
      'output-rejected',
    )!
    expect(worst.params.stageKey).toBe('b')
  })

  test('rework-cost: a quarter of the tokens; workflows only', () => {
    expect(ids(base({ reworkTokenShare: 0.24 }))).toEqual([])
    expect(ids(base({ kind: 'workgroup', reworkTokenShare: 0.5 }))).toEqual([])
    expect(
      one(
        base({ reworkTokenShare: 0.25, reworkTokens: 840_000, reworkCostNano: 11 }),
        'rework-cost',
      ),
    ).toMatchObject({
      severity: 'info',
      target: 'overview',
      params: { share: 0.25, tokens: 840_000, costNano: 11 },
    })
    expect(one(base({ reworkTokenShare: 0.4 }), 'rework-cost')!.severity).toBe('mid')
  })

  test('clarify rules: half adopted the recommendation, or 30% wrote their own; ten answers', () => {
    const clarify = (
      recommendedRate: number | null,
      customRate: number | null,
      answered = 10,
      recommendable = answered,
    ) => base({ clarify: { answered, recommendable, recommendedRate, customRate } })
    expect(ids(clarify(0.49, 0.29))).toEqual([])
    expect(ids(clarify(0.9, 0.9, 9))).toEqual([])
    expect(ids(clarify(0.5, 0.1))).toEqual(['clarify-mostly-recommended'])
    expect(ids(clarify(0.1, 0.3))).toEqual(['options-unfit'])
    expect(ids(clarify(null, null))).toEqual([])
  })

  test('the recommended rate needs ten answers to questions that offered a recommendation', () => {
    // Regression: the minimum was checked on all answers, so two recommendable answers out of
    // forty, both taking the recommendation, read as "100% take the recommended option".
    const clarify = (recommendable: number) =>
      base({ clarify: { answered: 40, recommendable, recommendedRate: 1, customRate: 0 } })
    expect(ids(clarify(2))).toEqual([])
    expect(ids(clarify(9))).toEqual([])
    // The number in the sentence is the rate's own sample.
    expect(one(clarify(10), 'clarify-mostly-recommended')!.params).toEqual({
      rate: 1,
      answered: 10,
    })
    // "Wrote their own" is a share of every answer: its minimum stays on all of them.
    expect(
      ids(
        base({
          clarify: { answered: 10, recommendable: 0, recommendedRate: null, customRate: 0.5 },
        }),
      ),
    ).toEqual(['options-unfit'])
  })

  test('loop-capped: 10% of invocations, at least five units; workflows only', () => {
    const loop = (
      loopCapRate: number,
      units = 5,
      kind: HintFacts['kind'] = 'workflow',
      loopRuns = 12,
    ) =>
      base({
        kind,
        units,
        stages: [stage({ key: 'loop', loopRuns, loopCapRate, loopRoundsMean: 2.6 })],
      })
    expect(ids(loop(0.09))).toEqual([])
    expect(ids(loop(0.5, 4))).toEqual([])
    expect(ids(loop(0.5, 9, 'workgroup'))).toEqual([])
    // Regression: twenty tasks of which one reached the loop and hit the cap is a sample of one.
    expect(ids(loop(1, 20, 'workflow', 1))).toEqual([])
    expect(ids(loop(1, 20, 'workflow', 4))).toEqual([])
    expect(ids(loop(1, 20, 'workflow', 5))).toEqual(['loop-capped'])
    expect(one(loop(0.1), 'loop-capped')).toMatchObject({
      severity: 'mid',
      params: { stageKey: 'loop', rate: 0.1, rounds: 2.6 },
    })
    expect(one(loop(0.25), 'loop-capped')!.severity).toBe('high')
    // A stage that is not a loop never triggers it, whatever its numbers.
    expect(ids(base({ stages: [stage({ loopRuns: 0, loopCapRate: 0.9 })] }))).toEqual([])
  })

  test('auto-retry-high: 15% over at least ten runs, with the top failure code', () => {
    const facts = (autoRetryRate: number, runs = 10, kind: HintFacts['kind'] = 'workflow') =>
      base({
        kind,
        stages: [
          stage({
            key: 'audit',
            runs,
            autoRetryRate,
            topFailureCode: 'envelope-missing',
            topFailureShare: 0.61,
          }),
        ],
      })
    expect(ids(facts(0.14))).toEqual([])
    expect(ids(facts(0.9, 9))).toEqual([])
    expect(one(facts(0.15), 'auto-retry-high')).toMatchObject({
      severity: 'mid',
      target: 'stages',
      params: { stageKey: 'audit', rate: 0.15, code: 'envelope-missing', codeShare: 0.61 },
    })
    expect(one(facts(0.3), 'auto-retry-high')!.severity).toBe('high')
    expect(one(facts(0.2, 20, 'workgroup'), 'auto-retry-high')!.target).toBe('members')
  })

  test('first-pass-low: at most 30%, with at least five units it was judged for', () => {
    expect(ids(base({ firstPassRate: 0.31 }))).toEqual([])
    expect(ids(base({ firstPassRate: 0.1, firstPassUnits: 4 }))).toEqual([])
    // Regression: a digital employee is judged on merged cases only. Twenty succeeded cases of
    // which two were merged, neither at the first pass, is a sample of two.
    expect(
      ids(
        base({ kind: 'digital-employee', firstPassRate: 0, succeededUnits: 20, firstPassUnits: 2 }),
      ),
    ).toEqual([])
    expect(
      one(
        base({ kind: 'digital-employee', firstPassRate: 0, succeededUnits: 20, firstPassUnits: 5 }),
        'first-pass-low',
      )!.params,
    ).toEqual({ rate: 0, units: 5 })
    expect(one(base({ firstPassRate: 0.3 }), 'first-pass-low')!.severity).toBe('mid')
    expect(one(base({ firstPassRate: 0.15 }), 'first-pass-low')!.severity).toBe('high')
    expect(ids(base({ firstPassRate: null }))).toEqual([])
  })

  test('workgroup rules', () => {
    const group = (over: Partial<HintFacts>) => base({ kind: 'workgroup', ...over })
    expect(ids(group({ coordinationShare: 0.19 }))).toEqual([])
    expect(ids(group({ coordinationShare: 0.5, units: 4 }))).toEqual([])
    expect(ids(base({ coordinationShare: 0.5 }))).toEqual([])
    expect(one(group({ coordinationShare: 0.2 }), 'coordination-high')).toMatchObject({
      severity: 'high',
      target: 'rounds',
    })

    const completion = (rejectRate: number, rounds = 5) =>
      group({ completion: { rounds, rejectRate, extraRounds: 1.8 } })
    expect(ids(completion(0.14))).toEqual([])
    expect(ids(completion(0.9, 4))).toEqual([])
    expect(one(completion(0.15), 'completion-rejected')).toMatchObject({
      severity: 'mid',
      params: { rate: 0.15, rounds: 5, extraRounds: 1.8 },
    })
    expect(one(completion(0.3), 'completion-rejected')!.severity).toBe('high')

    const delivery = (p50: number, waitShare: number) => group({ delivery: { p50, waitShare } })
    expect(ids(delivery(H - 1, 0.5))).toEqual([])
    expect(ids(delivery(2 * H, 0.14))).toEqual([])
    expect(ids(delivery(H, 0.15))).toEqual(['human-delivery-slow'])
  })

  test('digital employee rules', () => {
    const employee = (over: Partial<HintFacts>) => base({ kind: 'digital-employee', ...over })
    const blocked = (rate: number, units = 5) =>
      employee({ units, blocked: { rate, p50: 2 * H, current: 2 } })
    expect(ids(blocked(0.19))).toEqual([])
    expect(ids(blocked(0.9, 4))).toEqual([])
    expect(ids(base({ blocked: { rate: 0.9, p50: null, current: 0 } }))).toEqual([])
    expect(one(blocked(0.2), 'blocked-high')).toMatchObject({
      severity: 'mid',
      params: { rate: 0.2, p50: 2 * H, current: 2 },
    })
    expect(one(blocked(0.4), 'blocked-high')!.severity).toBe('high')

    const repeated = (roundsPerUnit: number, units = 5, itemUnits = units) =>
      employee({
        units,
        stages: [stage({ key: 'fix-ci', units: itemUnits, roundsPerUnit, failureRate: 0.14 })],
      })
    expect(ids(repeated(1.9))).toEqual([])
    expect(ids(repeated(9, 4))).toEqual([])
    // Regression: the rounds are averaged over the cases that ran the work item, so the minimum
    // is theirs: one case that ran it nine times among twenty is a sample of one.
    expect(ids(repeated(9, 20, 1))).toEqual([])
    expect(ids(repeated(9, 20, 4))).toEqual([])
    expect(ids(repeated(9, 20, 5))).toEqual(['work-item-repeated'])
    expect(one(repeated(2), 'work-item-repeated')).toMatchObject({
      severity: 'mid',
      params: { stageKey: 'fix-ci', rounds: 2, failureRate: 0.14 },
    })
    expect(one(repeated(2.5), 'work-item-repeated')!.severity).toBe('high')
  })

  test('hints come most severe first and keep the rule order within a severity', () => {
    const hints = hintsOf(
      base({
        waitShare: 0.5, // mid
        firstPassRate: 0.1, // high
        reworkTokenShare: 0.3, // info
        clarify: { answered: 20, recommendable: 20, recommendedRate: 0.9, customRate: 0.1 }, // mid
        stages: [stage({ key: 'design', rejectRate: 0.9, reviewRounds: 9 })], // high
      }),
    )
    expect(hints.map((hint) => [hint.id, hint.severity])).toEqual([
      ['output-rejected', 'high'],
      ['first-pass-low', 'high'],
      ['wait-dominant', 'mid'],
      ['clarify-mostly-recommended', 'mid'],
      ['rework-cost', 'info'],
    ])
    for (const hint of hints) expect(PROCESS_HINT_IDS).toContain(hint.id)
  })
})

describe('RFC-616 text themes', () => {
  const item = (over: Partial<InsightSourceItem> & { text: string }): InsightSourceItem => ({
    source: 'review',
    unitId: 'task-1',
    stageKey: 'design',
    at: 1_000,
    ...over,
  })

  test('items are numbered per source in reading order; blank items are dropped', () => {
    const prepared = prepareInsightItems([
      item({ text: 'third', at: 3 }),
      item({ text: '  first  ', at: 1 }),
      item({ text: '   ', at: 2 }),
      item({ source: 'clarify', text: 'Q: jdk?\nA: 21', at: 2 }),
    ])
    expect(prepared.items.map((entry) => [entry.id, entry.text])).toEqual([
      ['r1', 'first'],
      ['c1', 'Q: jdk?\nA: 21'],
      ['r2', 'third'],
    ])
    expect(prepared.newestAt).toBe(3)
    expect(prepared.truncated.size).toBe(0)
    expect(prepareInsightItems([]).newestAt).toBeNull()
  })

  test('the newest items win when there are too many, and long items are cut', () => {
    const many = Array.from({ length: PROCESS_INSIGHT_MAX_ITEMS + 3 }, (_, index) =>
      item({ text: `comment ${index}`, at: index }),
    )
    const prepared = prepareInsightItems(many)
    expect(prepared.items).toHaveLength(PROCESS_INSIGHT_MAX_ITEMS)
    expect(prepared.items[0]!.text).toBe('comment 3')
    expect(prepared.truncated.has('review')).toBe(true)
    expect(prepared.newestAt).toBe(PROCESS_INSIGHT_MAX_ITEMS + 2)

    const long = prepareInsightItems([item({ text: 'x'.repeat(PROCESS_INSIGHT_ITEM_CHARS + 50) })])
    expect(long.items[0]!.text).toHaveLength(PROCESS_INSIGHT_ITEM_CHARS)
  })

  test('the prompt lists every item under its source with its id', () => {
    const prepared = prepareInsightItems([
      item({ text: 'no idempotency\nkey', at: 1 }),
      item({ source: 'workgroup-rejection', text: 'tests missing', at: 2 }),
    ])
    const prompt = buildInsightPrompt(prepared, 'Requirement to merge')
    expect(prompt).toContain('"Requirement to merge"')
    expect(prompt).toContain('## source: review\n[r1] no idempotency key')
    expect(prompt).toContain('## source: workgroup-rejection\n[j1] tests missing')
    expect(prompt).not.toContain('## source: clarify')
  })

  test('the first JSON object of an answer is read, whatever surrounds it', () => {
    expect(extractJsonObject('Here you go:\n```json\n{"groups":[]}\n```')).toEqual({ groups: [] })
    expect(extractJsonObject('no json here')).toBeNull()
    expect(extractJsonObject('{broken')).toBeNull()
  })

  const prepared = prepareInsightItems([
    item({ text: 'idempotency key missing', at: 1, unitId: 'task-1', stageKey: 'design' }),
    item({ text: 'no retry on shard failure', at: 2, unitId: 'task-2', stageKey: 'design' }),
    item({ text: 'field types missing', at: 3, unitId: 'task-2', stageKey: 'code' }),
    item({ text: 'ok', at: 4, unitId: 'task-3', stageKey: null }),
    item({ source: 'clarify', text: 'Q: JDK?\nA: 21', at: 5, unitId: 'task-1', stageKey: 'ask' }),
  ])

  test('counts, shares and excerpts are computed from the items', () => {
    const groups = groupThemes(
      JSON.stringify({
        groups: [
          {
            source: 'review',
            themes: [
              // The model's own numbers and quotes are ignored: only ids matter.
              {
                name: ' Edge cases ',
                itemIds: ['r1', 'r2', 'r404'],
                advice: ' Add a template. ',
                count: 99,
              },
              { name: 'Contracts', itemIds: ['r3', 'r1'], advice: 'Check the fields.' },
              { name: 'Nothing real', itemIds: ['x1'], advice: '' },
            ],
          },
        ],
      }),
      prepared,
    )!
    const review = groups.find((group) => group.source === 'review')!
    expect(review.items).toBe(4)
    expect(review.otherItems).toBe(1)
    expect(review.themes).toEqual([
      {
        name: 'Edge cases',
        items: 2,
        share: 2 / 4,
        stages: ['design'],
        quotes: [
          { text: 'idempotency key missing', unitId: 'task-1' },
          { text: 'no retry on shard failure', unitId: 'task-2' },
        ],
        advice: 'Add a template.',
      },
      {
        // r1 already belongs to the first theme that cited it.
        name: 'Contracts',
        items: 1,
        share: 1 / 4,
        stages: ['code'],
        quotes: [{ text: 'field types missing', unitId: 'task-2' }],
        advice: 'Check the fields.',
      },
    ])
    // A source the model said nothing about is still reported, with everything in "other".
    expect(groups.find((group) => group.source === 'clarify')).toEqual({
      source: 'clarify',
      items: 1,
      truncated: false,
      themes: [],
      otherItems: 1,
    })
  })

  test('at most six themes per source are kept, the largest first', () => {
    const items = Array.from({ length: 20 }, (_, index) => item({ text: `t${index}`, at: index }))
    const many = prepareInsightItems(items)
    // Eight disjoint themes of 1, 1, 1, 1, 2, 2, 3 and 3 items (14 of the 20).
    const sizes = [1, 1, 1, 1, 2, 2, 3, 3]
    let offset = 0
    const themes = sizes.map((size, index) => {
      const itemIds = many.items.slice(offset, offset + size).map((entry) => entry.id)
      offset += size
      return { name: `theme ${index}`, itemIds, advice: '' }
    })
    const [group] = groupThemes(JSON.stringify({ groups: [{ source: 'review', themes }] }), many)!
    expect(group!.themes).toHaveLength(6)
    expect(group!.themes.map((theme) => theme.items)).toEqual([3, 3, 2, 2, 1, 1])
    expect(group!.otherItems).toBe(20 - 12)
  })

  test('an answer that is not the requested document is rejected as a whole', () => {
    expect(groupThemes('I could not do that.', prepared)).toBeNull()
    expect(groupThemes('{"groups":"nope"}', prepared)).toBeNull()
    expect(
      groupThemes('{"groups":[{"source":"review","themes":[{"itemIds":["r1"]}]}]}', prepared),
    ).toBeNull()
    // An empty but well-formed answer is accepted: nothing recurs.
    expect(
      groupThemes('{"groups":[]}', prepared)!.every((group) => group.themes.length === 0),
    ).toBe(true)
  })
})
