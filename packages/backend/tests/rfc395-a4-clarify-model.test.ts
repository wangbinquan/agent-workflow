// RFC-395 II-a A4: target per-question rules and the shared projection must retain every legacy answer shape.
import { describe, expect, test } from 'bun:test'
import {
  ClarifyQuestionSchema,
  renderFlatClarifyQueue,
  type ClarifyAnswer,
} from '@agent-workflow/shared'
import {
  clarifyAnswerState,
  classifyClarifyReseal,
  clarifyRoundTransition,
  freezeAnswerAttributions,
  isClarifyQuestionSealed,
  projectClarifyAnswers,
  saveClarifyQuestionDraft,
  sealedClarifyQuestionIds,
  sealClarifyAnswers,
} from '@/modules/collaboration/domain/clarifyAnswers'
import {
  appendClarifyQuestions,
  clarifyQuestionsRevision,
  duplicateClarifyQuestionIds,
} from '@/modules/collaboration/domain/clarifyQuestions'
import { decodeLegacyClarifyAnswerColumns } from '@/modules/collaboration/infrastructure/clarifyAnswerCodec'
import { clarifyAnswerContentForPrompt } from '@/modules/collaboration/public/queries'
import {
  parseAnswersArray,
  parseAnswers,
  safeParseArray,
  parseArray,
  parseJsonRecord,
} from './helpers/clarifyHeadParsers'

const q = (id: string) =>
  ClarifyQuestionSchema.parse({ id, title: id, kind: 'single', options: ['A', 'B'] })
const a = (id: string, text = ''): ClarifyAnswer => ({
  questionId: id,
  selectedOptionIndices: [],
  selectedOptionLabels: [],
  customText: text,
})
const owner = { userId: 'owner', role: 'owner' as const }
const member = { userId: 'member', role: 'user' as const }
const questions = [q('a'), q('b')]
const seal = (
  state: ReturnType<typeof clarifyAnswerState>,
  incoming: ClarifyAnswer[],
  extra: Partial<Parameters<typeof sealClarifyAnswers>[0]> = {},
) =>
  sealClarifyAnswers({
    state,
    incoming,
    questions,
    status: 'awaiting_human',
    alreadySealed: new Set(),
    directive: null,
    sealedBy: owner.userId,
    sealedByRole: owner.role,
    now: 30,
    ...extra,
  })

describe('逐题编辑 / 封口状态转移', () => {
  test('two editors on different questions and same-question LWW do not mutate the prior state', () => {
    const initial = clarifyAnswerState(null)
    const first = saveClarifyQuestionDraft(initial, 'a', a('a', 'first'), owner, 1)
    const second = saveClarifyQuestionDraft(first, 'b', a('b', 'second'), member, 2)
    const last = saveClarifyQuestionDraft(second, 'a', a('a', 'last'), member, 3)
    expect(projectClarifyAnswers(last).draftAnswers).toEqual({
      a: a('a', 'last'),
      b: a('b', 'second'),
    })
    expect(last.attributions).toEqual({
      a: { ...member, updatedAt: 3 },
      b: { ...member, updatedAt: 2 },
    })
    expect(initial.drafts).toBeNull()
    expect(first.drafts).toEqual({ a: a('a', 'first') })
  })

  test('partial seal preserves live drafts; full seal freezes matching editor and proxy submitter in seal order', () => {
    const state = saveClarifyQuestionDraft(
      saveClarifyQuestionDraft(clarifyAnswerState(null), 'a', a('a', 'draft'), owner, 1),
      'b',
      a('b', 'kept'),
      member,
      2,
    )
    const partial = seal(state, [a('b', 'kept')], { requestedDirective: 'stop' })
    expect(partial.flipNow).toBe(false)
    expect(partial.freeze).toBe(false)
    expect(partial.state.attributions).toBe(state.attributions)
    expect(partial.state.drafts).toBe(state.drafts)
    const full = seal(partial.state, [a('a', 'changed at submit')], {
      alreadySealed: new Set(['b']),
      requestedDirective: 'stop',
    })
    expect(full.flipNow).toBe(true)
    expect(full.directive).toBe('stop')
    expect(full.state.drafts).toBeNull()
    expect(projectClarifyAnswers(full.state).answers).toEqual([
      a('b', 'kept'),
      a('a', 'changed at submit'),
    ])
    expect(full.state.attributions).toEqual({
      b: { ...member, updatedAt: 2 },
      a: { ...owner, updatedAt: 30 },
    })
    const again = seal(full.state, [a('b', 're-answer')], {
      status: 'answered',
      alreadySealed: new Set(['a', 'b']),
      directive: 'stop',
      requestedDirective: 'continue',
    })
    expect(again.fullySealed).toBe(true)
    expect(again.flipNow).toBe(false)
    expect(again.freeze).toBe(false)
    expect(again.directive).toBe('stop')
    expect(again.state.attributions).toBe(full.state.attributions)
  })

  test('full seal without both actor facts retains draft bytes and live attribution', () => {
    const state = saveClarifyQuestionDraft(clarifyAnswerState(null), 'a', a('a'), member, 1)
    for (const facts of [{ sealedBy: undefined }, { sealedByRole: undefined }]) {
      const full = seal(state, [a('a'), a('b')], facts)
      expect(full.flipNow).toBe(true)
      expect(full.freeze).toBe(false)
      expect(full.state.drafts).toBe(state.drafts)
      expect(full.state.attributions).toBe(state.attributions)
    }
  })

  test('re-answer requires a declaration and every existing entry pending, including historical echo entries', () => {
    const row = { questionId: 'a', sealedAt: 1, stagedAt: null, dispatchedAt: null }
    expect(classifyClarifyReseal(new Set(['a', 'b']), new Set(['a']), [row], ['a'])).toEqual({
      fresh: new Set(['b']),
      resealed: new Set(['a']),
      rejected: null,
    })
    for (const entries of [
      [],
      [{ ...row, stagedAt: 2 }],
      [{ ...row, dispatchedAt: 3 }],
      [row, { ...row, dispatchedAt: 3 }],
    ]) {
      expect(classifyClarifyReseal(new Set(['a']), new Set(['a']), entries, ['a']).rejected).toBe(
        'a',
      )
    }
    expect(classifyClarifyReseal(new Set(['a']), new Set(['a']), [row]).rejected).toBe('a')
    const current = { ...row, id: 'current', originNodeRunId: 'current-round', roleKind: 'self' }
    const echo = {
      ...row,
      id: 'historical-echo',
      originNodeRunId: 'older-round',
      roleKind: 'questioner',
    }
    expect(
      classifyClarifyReseal(new Set(['a']), new Set(['a']), [current, echo], ['a']).rejected,
    ).toBeNull()
    for (const consumedEcho of [
      { ...echo, stagedAt: 2 },
      { ...echo, dispatchedAt: 3 },
    ]) {
      expect(
        classifyClarifyReseal(new Set(['a']), new Set(['a']), [current, consumedEcho], ['a'])
          .rejected,
      ).toBe('a')
    }
  })

  test('reopen clears answers only; cancel / abandon keep drafts, answers and attribution', () => {
    expect(clarifyRoundTransition('reopen', 99)).toEqual({
      status: 'awaiting_human',
      answers: null,
      answeredAt: null,
    })
    expect(clarifyRoundTransition('cancel', 99)).toEqual({ status: 'canceled' })
    expect(clarifyRoundTransition('abandon', 99)).toEqual({ status: 'abandoned', abandonedAt: 99 })
    expect(isClarifyQuestionSealed('awaiting_human', 1)).toBe(true)
    expect(isClarifyQuestionSealed('answered', null)).toBe(true)
    expect(isClarifyQuestionSealed('awaiting_human', null)).toBe(false)
    expect(sealedClarifyQuestionIds(questions, 'answered', [])).toEqual(new Set(['a', 'b']))
  })

  test('duplicate historical ids retain occurrences; replacements keep the original seal slots', () => {
    const old = [a('b', 'one'), a('a', 'two'), a('b', 'three')]
    const state = clarifyAnswerState(old)
    const projection = projectClarifyAnswers(state)
    expect(projection.answers).toEqual(old)
    expect(projection.firstAnswer('b')).toEqual(old[0])
    expect(projection.answerMap().get('b')).toEqual(old[2])
    expect(projection.effectiveAnswers().b).toEqual(old[2])
    expect(projectClarifyAnswers(seal(state, [a('b', 'new')]).state).answers).toEqual([
      a('b', 'new'),
      old[1]!,
      a('b', 'new'),
    ])
    expect(
      projectClarifyAnswers(seal(clarifyAnswerState(null), [a('a', 'first'), a('a', 'last')]).state)
        .answers,
    ).toEqual([a('a', 'first')])
  })

  test('attribution equality compares sorted indices and decision, not labels or confirmation basis', () => {
    const submitted = {
      ...a('a'),
      selectedOptionIndices: [1, 0],
      selectedOptionLabels: ['changed'],
    }
    const attribution = { ...member, updatedAt: 7 }
    expect(
      freezeAnswerAttributions({
        answers: [submitted],
        draftAnswers: { a: { ...submitted, selectedOptionIndices: [0, 1] } },
        draftAttributions: { a: attribution },
        submitter: owner,
        now: 8,
      }),
    ).toEqual({ a: attribution })
  })

  test('follow-ups only append and advance the question-set revision; historical duplicates remain explicit', () => {
    const original = clarifyQuestionsRevision(questions)
    const next = appendClarifyQuestions(original, [q('c')])
    expect(next.questions.slice(0, 2)).toEqual(questions)
    expect(next.questions[0]).toBe(questions[0])
    expect(next.previousKey).toBe(original.key)
    expect(next.key).not.toBe(original.key)
    expect(next.duplicateIds).toEqual([])
    expect(duplicateClarifyQuestionIds([q('a'), q('a'), q('b'), q('a')])).toEqual(['a'])
    expect(appendClarifyQuestions(original, [q('a')]).duplicateIds).toEqual(['a'])
  })
})

describe('HEAD parser and prompt parity', () => {
  const shapes = [
    null,
    '',
    '{',
    'null',
    '{}',
    '0',
    '"legacy"',
    '[]',
    JSON.stringify([a('b'), a('a', '中文'), a('b', 'last')]),
  ]
  for (const raw of shapes)
    test(`answers shape ${String(raw)}`, () => {
      const projection = decodeLegacyClarifyAnswerColumns({ answersJson: raw })
      expect(projection.answers ?? []).toEqual(parseAnswersArray(raw))
      expect(projection.answers ?? []).toEqual(parseAnswers(raw))
      expect(projection.optionalAnswers).toEqual(safeParseArray(raw))
      expect(projection.optionalAnswers).toEqual(parseArray(raw))
      let detail
      if (raw !== null) {
        try {
          detail = JSON.parse(raw)
        } catch {
          /* HEAD leaves undefined */
        }
      }
      expect(projection.detailAnswers).toEqual(detail)
      const pretty = (value: string) => {
        try {
          return '```json\n' + JSON.stringify(JSON.parse(value), null, 2).slice(0, 4000) + '\n```'
        } catch {
          return '```\n' + value.slice(0, 4000) + '\n```'
        }
      }
      expect(pretty(clarifyAnswerContentForPrompt(projection.content))).toBe(pretty(raw ?? '[]'))
    })
  for (const raw of [
    ...shapes,
    '{"b":{"customText":"draft"},"a":{"userId":"u","role":"user","updatedAt":1}}',
  ])
    test(`maps shape ${String(raw)}`, () => {
      const projection = decodeLegacyClarifyAnswerColumns({
        draftAnswersJson: raw,
        answerAttributionsJson: raw,
      })
      expect(projection.draftAnswers).toEqual(parseJsonRecord(raw))
      expect(projection.answerAttributions).toEqual(parseJsonRecord(raw))
    })
  test('NULL / [] and missing / blank remain distinct in prompt projection', () => {
    expect(decodeLegacyClarifyAnswerColumns({ answersJson: null }).answers).toBeNull()
    expect(decodeLegacyClarifyAnswerColumns({ answersJson: '[]' }).answers).toEqual([])
    const missing = renderFlatClarifyQueue([{ question: questions[0]!, answer: undefined }])
    const blank = renderFlatClarifyQueue([{ question: questions[0]!, answer: a('a') }])
    expect(missing).toContain('User did not answer this question.')
    expect(blank).toBe(missing)
    expect(projectClarifyAnswers(clarifyAnswerState([a('a')])).firstAnswer('a')).toEqual(a('a'))
    expect(projectClarifyAnswers(clarifyAnswerState([])).firstAnswer('a')).toBeUndefined()
  })
})
