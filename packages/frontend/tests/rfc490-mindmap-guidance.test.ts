// RFC-490 (design §6.2, §6.4, §6.5, §6.7): the pure pieces behind "skip in one step",
// "show the gap", "what is worth another look" and the grouped review. None of them
// stores state or calls a model; they are recomputed from the questions and answers
// on screen.
import { describe, expect, test } from 'vitest'
import {
  ClarifyQuestionSchema,
  clarifyAnswerBasis,
  clarifySkipStatus,
  isClarifyAnswerConfirmed,
  isClarifyAnswerValid,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import {
  explainClarifySkip,
  resumeClarifyAnswer,
  skipClarifyAnswer,
} from '../src/lib/clarify/mindmap/skip'
import {
  compressMindmapCategories,
  mindmapSearchSnippet,
  projectClarifyMindmap,
} from '../src/lib/clarify/mindmap/projection'
import { suggestMindmapSteps } from '../src/lib/clarify/mindmap/suggestions'
import { reviewMindmapDecisions } from '../src/lib/clarify/mindmap/review'

const question = (
  id: string,
  categoryPath: string[],
  extra: { parentQuestionId?: string; recommended?: boolean } = {},
): ClarifyQuestion =>
  ClarifyQuestionSchema.parse({
    id,
    title: `Question ${id}`,
    kind: 'single',
    options: [
      {
        label: 'Streaming replica',
        description: 'Needs a standby instance',
        recommended: extra.recommended === true,
        ...(extra.recommended ? { recommendationReason: 'Meets the recovery objective' } : {}),
      },
      { label: 'Nightly backup', description: 'Cheapest option' },
    ],
    mindmap: {
      categoryPath,
      ...(extra.parentQuestionId ? { parentQuestionId: extra.parentQuestionId } : {}),
    },
  })
const answer = (
  target: ClarifyQuestion,
  patch: Partial<ClarifyAnswer> = {},
  confirmed = true,
): ClarifyAnswer => {
  const value: ClarifyAnswer = {
    questionId: target.id,
    selectedOptionIndices: [0],
    selectedOptionLabels: [],
    customText: '',
    ...patch,
  }
  return confirmed ? { ...value, confirmedBasis: clarifyAnswerBasis(target, value) } : value
}
const skip = (target: ClarifyQuestion, status: 'deferred' | 'not-applicable') =>
  answer(target, { selectedOptionIndices: [], decision: { status } })

describe('RFC-490 empty configured categories', () => {
  const a = question('a', ['Performance', 'Database'])
  const paths = [['Performance'], ['Performance', 'Database'], ['Reliability', 'Recovery']]

  test('a configured path nobody asked about is projected as an empty group, after the asked ones', () => {
    const nodes = projectClarifyMindmap([a], {}, new Set(), 'Design', paths)
    expect(nodes.map((node) => node.id)).toEqual([
      'root',
      'g:["Performance"]',
      'g:["Performance","Database"]',
      'q:a',
      'g:["Reliability"]',
      'g:["Reliability","Recovery"]',
    ])
    const flags = Object.fromEntries(nodes.map((node) => [node.id, node.empty === true]))
    expect(flags).toEqual({
      root: false,
      'g:["Performance"]': false,
      'g:["Performance","Database"]': false,
      'q:a': false,
      'g:["Reliability"]': true,
      'g:["Reliability","Recovery"]': true,
    })
  })

  test('empty groups never change a count, and the canvas folds their chain like any other', () => {
    const without = projectClarifyMindmap([a], { a: answer(a) }, new Set(), 'Design')
    const withPaths = projectClarifyMindmap([a], { a: answer(a) }, new Set(), 'Design', paths)
    expect(withPaths[0]!.counts).toEqual(without[0]!.counts)
    expect(withPaths[0]!.status).toBe('done')
    const folded = compressMindmapCategories(withPaths)
    expect(folded.find((node) => node.id === 'g:["Reliability","Recovery"]')).toMatchObject({
      title: 'Reliability / Recovery',
      parentId: 'root',
      empty: true,
    })
    // Without configuration the projection is exactly what it was.
    expect(projectClarifyMindmap([a], {}, new Set(), 'Design', [])).toEqual(
      projectClarifyMindmap([a], {}, new Set(), 'Design'),
    )
  })

  test('search text covers options, the custom answer and the rationale, with a snippet', () => {
    const [, , , node] = projectClarifyMindmap(
      [a],
      {
        a: answer(a, { customText: 'PITR within fifteen minutes', decision: { rationale: 'SLA' } }),
      },
      new Set(),
      'Design',
    )
    for (const term of ['Streaming replica', 'Cheapest option', 'PITR', 'SLA'])
      expect(node!.searchText).toContain(term)
    expect(mindmapSearchSnippet(node!.searchText!, 'pitr')).toContain('PITR within')
    expect(mindmapSearchSnippet(node!.searchText!, 'absent')).toBe('')
    expect(mindmapSearchSnippet(node!.searchText!, '')).toBe('')
    // A long text is cut around the hit, with an ellipsis on each cut side.
    const snippet = mindmapSearchSnippet(`${'a'.repeat(60)} needle ${'b'.repeat(60)}`, 'NEEDLE')
    expect(snippet).toMatch(/^…a+ needle b+…$/)
    expect(snippet.length).toBeLessThan(60)
  })

  test('the reason a recommendation was given is searchable too', () => {
    const recommended = question('rec', ['Performance'], { recommended: true })
    const node = projectClarifyMindmap([recommended], {}, new Set(), 'Design').at(-1)!
    expect(node.searchText).toContain('Meets the recovery objective')
  })
})

describe('RFC-490 skipping a question (design §6.2)', () => {
  const q = question('q', ['Performance'])
  const picked = answer(q, {
    selectedOptionIndices: [1],
    decision: { status: 'decided', rationale: 'Measured last quarter', tradeoff: 'Slower restore' },
  })

  test('one step empties, marks and confirms the answer', () => {
    for (const status of ['not-applicable', 'deferred'] as const) {
      const skipped = skipClarifyAnswer(q, picked, status)
      expect(skipped).toMatchObject({
        questionId: 'q',
        selectedOptionIndices: [],
        selectedOptionLabels: [],
        customText: '',
        decision: { status },
      })
      expect(clarifySkipStatus(skipped)).toBe(status)
      expect(isClarifyAnswerValid(q, skipped)).toBe(true)
      expect(isClarifyAnswerConfirmed(q, skipped)).toBe(true)
    }
  })

  test('a note on the skip keeps it confirmed; switching the kind keeps the note', () => {
    const skipped = skipClarifyAnswer(q, picked, 'not-applicable')
    const noted = explainClarifySkip(q, skipped, 'Single region only')
    expect(noted.decision).toEqual({ status: 'not-applicable', rationale: 'Single region only' })
    expect(isClarifyAnswerConfirmed(q, noted)).toBe(true)
    // Clearing the note again is still a confirmed skip.
    const cleared = explainClarifySkip(q, noted, '')
    expect(cleared.decision).toEqual({ status: 'not-applicable' })
    expect(isClarifyAnswerConfirmed(q, cleared)).toBe(true)
    const later = skipClarifyAnswer(q, noted, 'deferred')
    expect(later.decision).toEqual({ status: 'deferred', rationale: 'Single region only' })
    expect(isClarifyAnswerConfirmed(q, later)).toBe(true)
    // Not a skipped answer: nothing to explain, nothing changes.
    expect(explainClarifySkip(q, picked, 'ignored')).toBe(picked)
  })

  test('answering instead brings back what was there, unconfirmed', () => {
    const skipped = explainClarifySkip(
      q,
      skipClarifyAnswer(q, picked, 'deferred'),
      'Waiting for the load test',
    )
    const resumed = resumeClarifyAnswer(skipped, picked)
    expect(resumed).toEqual({
      questionId: 'q',
      selectedOptionIndices: [1],
      selectedOptionLabels: [],
      customText: '',
      // The earlier rationale returns; the note written for the skip gives way to it.
      decision: {
        status: 'decided',
        rationale: 'Measured last quarter',
        tradeoff: 'Slower restore',
      },
    })
    expect(isClarifyAnswerConfirmed(q, resumed)).toBe(false)
    expect(clarifySkipStatus(resumed)).toBeUndefined()
  })

  test('with nothing remembered the question is simply unanswered again, note kept', () => {
    const skipped = explainClarifySkip(
      q,
      skipClarifyAnswer(q, answer(q, { selectedOptionIndices: [] }, false), 'deferred'),
      'Waiting for the load test',
    )
    expect(resumeClarifyAnswer(skipped, undefined)).toEqual({
      questionId: 'q',
      selectedOptionIndices: [],
      selectedOptionLabels: [],
      customText: '',
      decision: { rationale: 'Waiting for the load test' },
    })
    // No note and nothing remembered: a plain empty answer without a decision object.
    expect(resumeClarifyAnswer(skipClarifyAnswer(q, picked, 'deferred'), undefined)).toEqual({
      questionId: 'q',
      selectedOptionIndices: [],
      selectedOptionLabels: [],
      customText: '',
    })
    // An answer remembered without a rationale takes the note as its rationale.
    const plain = answer(q, { selectedOptionIndices: [0] }, false)
    expect(resumeClarifyAnswer(skipped, plain).decision).toEqual({
      rationale: 'Waiting for the load test',
    })
  })
})

describe('RFC-490 next-step suggestions', () => {
  const rec = question('rec', ['Performance'], { recommended: true })
  const prov = question('prov', ['Performance'])
  const bare = question('bare', ['Performance'])
  const later = question('later', ['Performance'])
  const na = question('na', ['Performance'])
  const explained = question('explained', ['Performance'])
  const questions = [rec, prov, bare, later, na, explained]
  const answers = {
    rec: answer(rec),
    prov: answer(prov, { decision: { status: 'provisional', rationale: 'No baseline yet' } }),
    bare: answer(bare, { selectedOptionIndices: [1] }),
    later: skip(later, 'deferred'),
    na: skip(na, 'not-applicable'),
    explained: answer(explained, {
      selectedOptionIndices: [1],
      decision: { status: 'decided', rationale: 'Measured last quarter' },
    }),
  }
  const categoryPaths = [['Performance'], ['Reliability'], ['Reliability', 'Recovery']]

  test('reports each kind once, in a fixed order, and only the deepest empty path', () => {
    expect(suggestMindmapSteps({ questions, answers, locked: new Set(), categoryPaths })).toEqual([
      { kind: 'empty-category', path: ['Reliability', 'Recovery'] },
      { kind: 'deferred', questionIds: ['later'] },
      { kind: 'provisional-unplanned', questionId: 'prov' },
      { kind: 'recommendation-unexamined', questionId: 'rec' },
      { kind: 'no-rationale', questionIds: ['bare'] },
    ])
  })

  test('a follow-up under a recommended answer counts as examining it; sealed and unanswered questions are left alone', () => {
    const child = question('child', ['Performance'], { parentQuestionId: 'rec' })
    const result = suggestMindmapSteps({
      questions: [rec, child, bare],
      answers: { rec: answer(rec), bare: answer(bare, { selectedOptionIndices: [1] }) },
      locked: new Set(['bare']),
      categoryPaths: [],
    })
    // "rec" has a follow-up, so it is only missing a rationale; "child" is unanswered.
    expect(result).toEqual([{ kind: 'no-rationale', questionIds: ['rec'] }])
    expect(
      suggestMindmapSteps({ questions: [], answers: {}, locked: new Set(), categoryPaths: [] }),
    ).toEqual([])
  })

  test('a map whose questions are all sealed has no gap left to suggest filling', () => {
    const sealed = { questions: [bare], answers: {}, categoryPaths: [['Reliability']] }
    expect(suggestMindmapSteps({ ...sealed, locked: new Set(['bare']) })).toEqual([])
    expect(suggestMindmapSteps({ ...sealed, locked: new Set() })).toEqual([
      { kind: 'empty-category', path: ['Reliability'] },
    ])
  })

  test('a provisional decision with both an owner and a review time is not reported', () => {
    expect(
      suggestMindmapSteps({
        questions: [prov],
        answers: {
          prov: answer(prov, {
            decision: {
              status: 'provisional',
              rationale: 'No baseline yet',
              validationOwner: 'Lin',
              revisitWhen: 'After two weeks',
            },
          }),
        },
        locked: new Set(),
        categoryPaths: [],
      }),
    ).toEqual([])
  })
})

describe('RFC-490 grouped review', () => {
  const p1 = question('p1', ['Performance', 'Database'])
  const p1a = question('p1a', ['Performance', 'Database'], { parentQuestionId: 'p1' })
  const r1 = question('r1', ['Reliability'])
  const p2 = question('p2', ['Performance', 'Database'])
  const questions = [p1, r1, p1a, p2]

  test('groups by category in first-seen order and keeps follow-ups under their parent', () => {
    const { groups } = reviewMindmapDecisions(questions, {}, new Set())
    expect(groups.map((group) => group.path)).toEqual([
      ['Performance', 'Database'],
      ['Reliability'],
    ])
    expect(groups[0]!.entries.map((entry) => [entry.question.id, entry.depth])).toEqual([
      ['p1', 0],
      ['p1a', 1],
      ['p2', 0],
    ])
    // Labels keep the round's numbering, wherever the entry is shown.
    expect(groups[0]!.entries.map((entry) => entry.index)).toEqual([0, 2, 3])
    expect(groups[0]!.entries[1]!.parentIndex).toBe(0)
  })

  test('counts every state once and flags what needs attention', () => {
    const answers = {
      p1: answer(p1, { decision: { status: 'decided', rationale: 'Measured' } }),
      p1a: answer(p1a, { decision: { status: 'provisional', rationale: 'Guess' } }),
      r1: skip(r1, 'not-applicable'),
      p2: answer(p2, {}, false),
    }
    const { summary, groups } = reviewMindmapDecisions(questions, answers, new Set())
    expect(summary).toEqual({
      total: 4,
      confirmed: 3,
      provisional: 1,
      unmarked: 1,
      notApplicable: 1,
      deferred: 0,
      noRationale: 1,
      attention: 2,
    })
    const attention = groups.flatMap((group) =>
      group.entries.filter((entry) => entry.attention).map((entry) => entry.question.id),
    )
    // Provisional, and answered-but-unconfirmed without a rationale. A confirmed
    // "not applicable" and a decided answer with a rationale need nothing.
    expect(attention).toEqual(['p1a', 'p2'])
  })

  test('an unanswered question is pending, not "unmarked"', () => {
    const { summary, groups } = reviewMindmapDecisions([p1], {}, new Set())
    expect(summary).toMatchObject({ total: 1, confirmed: 0, unmarked: 0, noRationale: 0 })
    expect(groups[0]!.entries[0]).toMatchObject({ answered: false, attention: true })
  })

  test('a sealed question counts as confirmed and a deferred one always needs attention', () => {
    const { summary, groups } = reviewMindmapDecisions(
      [p1, r1],
      { r1: skip(r1, 'deferred') },
      new Set(['p1']),
    )
    expect(summary.confirmed).toBe(2)
    expect(summary.deferred).toBe(1)
    expect(groups[1]!.entries[0]!.attention).toBe(true)
  })
})
