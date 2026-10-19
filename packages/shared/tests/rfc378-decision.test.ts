import { describe, expect, test } from 'bun:test'
import {
  ClarifyRoundSchema,
  ClarifyAnswerSchema,
  ClarifyDraftSaveBodySchema,
  ClarifyDraftValueSchema,
  ClarifyQuestionSchema,
  clarifyAnswerBasis,
  clarifyContentKey,
  clarifyFollowupContext,
  isClarifyAnswerConfirmed,
  normalizeClarifyDecision,
  renderUserPrompt,
  summariseClarifyAnswer,
  summariseCrossAnswer,
  type ClarifyAnswer,
} from '../src'

const q = ClarifyQuestionSchema.parse({
  id: 'q',
  title: 'Limit bookings?',
  kind: 'single',
  options: ['Limit', 'Observe first'],
  mindmap: { categoryPath: ['Scope'] },
})
const decision = {
  status: 'provisional' as const,
  rationale: 'We have no baseline.',
  tradeoff: 'Some conflicts may remain.',
  uncertainty: 'No-show rate unknown.',
  validationOwner: 'Lin',
  revisitWhen: 'After one week of observations',
}
const answer: ClarifyAnswer = {
  questionId: q.id,
  selectedOptionIndices: [1],
  selectedOptionLabels: ['Observe first'],
  customText: '',
  decision,
}

describe('RFC-378 optional decision contract', () => {
  // Real acceptance exposed compatible measures rendered as exclusive choices
  // and positional option labels broken by recommendation-first presentation.
  test('initial self/cross questions carry independent-option and evidence constraints', () => {
    for (const kind of ['self', 'cross'] as const) {
      const prompt = renderUserPrompt({
        promptTemplate: 'Clarify the requirement',
        inputs: {},
        meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
        agentOutputs: ['result'],
        clarifyChannel: { kind, directive: 'mandatory', injectStopNotice: false },
        clarifyMindmap: { categories: [], instructions: '' },
      })
      expect(prompt).toContain('recording usage and sending reminders are compatible')
      expect(prompt).toContain('The interface may reorder recommended options')
      expect(prompt).toContain('unless the user supplied evidence')
      expect(prompt).toContain('Parent attachment does not replace this required field')
    }
  })
  test('all answer and draft schemas preserve independent notes without inventing a status', () => {
    expect(ClarifyAnswerSchema.parse(answer).decision).toEqual(decision)
    expect(ClarifyDraftSaveBodySchema.parse({ ...answer, roundId: 'round' }).decision).toEqual(
      decision,
    )
    expect(ClarifyDraftValueSchema.parse(answer).decision).toEqual(decision)
    expect(ClarifyRoundSchema.shape.draftAnswers.parse({ q: answer })?.q?.decision).toEqual(
      decision,
    )
    expect(
      ClarifyAnswerSchema.parse({ ...answer, decision: { uncertainty: 'Unknown' } }).decision,
    ).toEqual({ uncertainty: 'Unknown' })
    expect(
      ClarifyAnswerSchema.parse({ ...answer, decision: { rationale: '  ' } }).decision,
    ).toBeUndefined()
    expect(
      ClarifyAnswerSchema.safeParse({ ...answer, decision: { validationOwner: 'x'.repeat(201) } })
        .success,
    ).toBe(false)
    expect(
      ClarifyAnswerSchema.safeParse({ ...answer, decision: { tradeoff: 'x'.repeat(2001) } })
        .success,
    ).toBe(false)
    expect(normalizeClarifyDecision(undefined)).toBeUndefined()
  })
  test('legacy confirmation stays byte identical; every meaningful decision edit invalidates it', () => {
    const old = { ...answer, decision: undefined }
    const basis = clarifyContentKey([q, [1], ''])
    expect(clarifyAnswerBasis(q, old)).toBe(basis)
    expect(clarifyAnswerBasis(q, { ...old, decision: {} })).toBe(basis)
    expect(isClarifyAnswerConfirmed(q, { ...old, confirmedBasis: basis })).toBe(true)
    const confirmed = { ...answer, confirmedBasis: clarifyAnswerBasis(q, answer) }
    for (const field of [
      'status',
      'rationale',
      'tradeoff',
      'uncertainty',
      'validationOwner',
      'revisitWhen',
    ] as const) {
      const next = {
        ...confirmed,
        decision: { ...decision, [field]: field === 'status' ? 'decided' : 'changed' },
      } as ClarifyAnswer
      expect(isClarifyAnswerConfirmed(q, next)).toBe(false)
    }
    expect(isClarifyAnswerConfirmed(q, confirmed)).toBe(true)
  })
  test('branch and category contexts both carry decisions, invalidating an outstanding follow-up basis', () => {
    for (const target of ['q', ['Scope']]) {
      const before = clarifyFollowupContext([q], { q: answer }, target)
      expect(before[0]?.answer.decision).toEqual(decision)
      const after = clarifyFollowupContext(
        [q],
        { q: { ...answer, decision: { ...decision, uncertainty: 'Changed' } } },
        target,
      )
      expect(clarifyContentKey(before)).not.toBe(clarifyContentKey(after))
    }
  })
  test('self and cross prompts retain every original decision field and scope final guidance to mindmaps', () => {
    const summary = summariseClarifyAnswer(q, answer)
    for (const value of Object.values(decision)) expect(summary).toContain(value)
    expect(summariseCrossAnswer(q, answer)).toBe(summary)
    const input = {
      promptTemplate: 'Design',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['result'],
      clarifyChannel: { kind: 'self', directive: 'stopped', injectStopNotice: true },
    } as const
    const ordinary = renderUserPrompt(input)
    const mindmap = renderUserPrompt({
      ...input,
      clarifyMindmap: { categories: [], instructions: '' },
    })
    expect(ordinary).not.toContain('invent evidence')
    expect(mindmap).toContain('invent evidence')
    expect(mindmap).toContain('unnamed owner')
    expect(mindmap).toContain('Unmarked answers remain unmarked')
    expect(mindmap).toContain('model-inferred consequences separately')
    expect(mindmap).not.toContain('Every question must include mindmap')
  })
  // Real final output promoted confirmed, unmarked answers into "decided".
  // Both prompt paths must explicitly retain absence instead of asking the model to infer it.
  test('mindmap summaries carry unmarked maturity while ordinary answers stay unchanged', () => {
    for (const notes of [undefined, {}, { uncertainty: 'Still unknown' }]) {
      const unmarked = { ...answer, decision: notes }
      for (const summarize of [summariseClarifyAnswer, summariseCrossAnswer]) {
        const summary = summarize(q, unmarked)
        expect(summary).toContain('Decision status: "unmarked"')
        expect(summary).not.toContain('Decision status (user marked)')
        if (notes?.uncertainty) expect(summary).toContain(notes.uncertainty)
        expect(summarize({ ...q, mindmap: undefined }, { ...unmarked, decision: undefined })).toBe(
          'User chose: "Observe first"',
        )
      }
    }
    expect(summariseClarifyAnswer(q, answer)).not.toContain('"unmarked"')
  })
})
