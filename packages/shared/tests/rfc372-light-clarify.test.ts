import { describe, expect, test } from 'bun:test'
import {
  ClarifyQuestionSchema,
  ClarifyFollowupSchema,
  clarifyAnswerBasis,
  clarifyContentKey,
  clarifyFollowupContext,
  clarifyQuestionSetKey,
  isClarifyAnswerConfirmed,
  parseClarifyEnvelopeBody,
  renderUserPrompt,
  validateClarifyMindmap,
  type ClarifyAnswer,
} from '../src'

const question = (id: string, parentQuestionId?: string) =>
  ClarifyQuestionSchema.parse({
    id,
    title: `Question ${id}`,
    kind: 'single',
    options: ['A', 'B'],
    mindmap: {
      categoryPath: ['Scope', 'Dependencies'],
      ...(parentQuestionId ? { parentQuestionId } : {}),
    },
  })
const answer = (questionId: string): ClarifyAnswer => ({
  questionId,
  selectedOptionIndices: [0],
  selectedOptionLabels: [],
  customText: '',
})

describe('RFC-372 classified questions on the original protocol', () => {
  test('ordinary parser and prompt remain identical when optional metadata is absent', () => {
    const raw = { questions: [{ id: 'q', title: 'Why?', kind: 'single', options: ['A', 'B'] }] }
    expect(
      parseClarifyEnvelopeBody(JSON.stringify(raw)).body?.questions[0]?.mindmap,
    ).toBeUndefined()
    const input = {
      promptTemplate: 'Design',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['design'],
      clarifyChannel: { kind: 'self', directive: 'mandatory', injectStopNotice: false },
    } as const
    expect(renderUserPrompt(input)).toBe(renderUserPrompt({ ...input, clarifyMindmap: undefined }))
    expect(renderUserPrompt(input)).not.toContain('categoryPath')
    const mindmap = renderUserPrompt({
      ...input,
      clarifyMindmap: { categories: ['Scope'], instructions: 'Ask about dependencies.' },
    })
    expect(mindmap).toContain('categoryPath')
    expect(mindmap).toContain('Ask about dependencies.')
    expect(mindmap).toContain('MANDATORY ASK-BACK')
    expect(
      renderUserPrompt({
        ...input,
        clarifyChannel: { ...input.clarifyChannel, directive: 'stopped' },
        clarifyMindmap: { categories: [], instructions: '' },
      }),
    ).not.toContain('categoryPath')
  })
  test('round trips classification and parents and rejects missing metadata, missing parents, duplicate IDs and cycles', () => {
    const qs = [question('a'), question('b', 'a')]
    const parsed = parseClarifyEnvelopeBody(JSON.stringify({ questions: qs }), { mindmap: true })
    expect(parsed.body?.questions).toEqual(qs)
    for (const bad of [
      [question('a', 'missing')],
      [question('a', 'b'), question('b', 'a')],
      [question('a'), question('a')],
      [{ ...question('a'), mindmap: undefined }],
    ]) {
      expect(
        parseClarifyEnvelopeBody(JSON.stringify({ questions: bad }), { mindmap: true }).body,
      ).toBeNull()
    }
    const deep = Array.from({ length: 5000 }, (_, i) =>
      question(String(i), i ? String(i - 1) : undefined),
    )
    expect(validateClarifyMindmap(deep, true)).toBeNull()
  })
  test('confirmation is tied to exact question and effective answer; empty/invalid values cannot turn green', () => {
    const q = question('a'),
      a = answer('a')
    const confirmed = { ...a, confirmedBasis: clarifyAnswerBasis(q, a) }
    expect(isClarifyAnswerConfirmed(q, confirmed)).toBe(true)
    expect(isClarifyAnswerConfirmed({ ...q, title: 'Changed' }, confirmed)).toBe(false)
    expect(isClarifyAnswerConfirmed(q, { ...confirmed, selectedOptionIndices: [1] })).toBe(false)
    for (const bad of [
      { ...a, selectedOptionIndices: [] },
      { ...a, selectedOptionIndices: [5] },
      { ...a, customText: 'also selected' },
    ]) {
      expect(
        isClarifyAnswerConfirmed(q, { ...bad, confirmedBasis: clarifyAnswerBasis(q, bad) }),
      ).toBe(false)
    }
    expect(
      isClarifyAnswerConfirmed(q, { ...confirmed, selectedOptionLabels: ['server label'] }),
    ).toBe(true)
  })
  test('follow-up context includes the complete ancestor chain and changes when an ancestor answer changes', () => {
    const qs = [question('a'), question('b', 'a'), question('c', 'b')]
    const drafts = { a: answer('a'), b: answer('b') }
    const context = clarifyFollowupContext(qs, drafts, 'c')
    expect(context.map((x) => x.question.id)).toEqual(['a', 'b', 'c'])
    expect(clarifyContentKey(context)).not.toBe(
      clarifyContentKey(
        clarifyFollowupContext(
          qs,
          { ...drafts, a: { ...drafts.a, selectedOptionIndices: [1] } },
          'c',
        ),
      ),
    )
    expect(clarifyQuestionSetKey(qs)).not.toBe(clarifyQuestionSetKey([...qs, question('d', 'c')]))
  })
})

test('category follow-up requires exactly one target and uses the complete category prefix', () => {
  const base = { requestId: 'bd73cae0-20b3-45a6-9f74-6c72e567232f', basis: 'v1:context' }
  expect(ClarifyFollowupSchema.safeParse(base).success).toBe(false)
  expect(
    ClarifyFollowupSchema.safeParse({ ...base, parentQuestionId: 'a', categoryPath: [] }).success,
  ).toBe(false)
  expect(ClarifyFollowupSchema.parse({ ...base, categoryPath: [] }).categoryPath).toEqual([])
  expect(ClarifyFollowupSchema.parse({ ...base, categoryPath: [' Scope '] }).categoryPath).toEqual([
    'Scope',
  ])
  expect(ClarifyFollowupSchema.safeParse({ ...base, categoryPath: [' '] }).success).toBe(false)
  const other = { ...question('other'), mindmap: { categoryPath: ['Scope extra'] } }
  const qs = [question('a'), question('b', 'a'), other]
  const context = clarifyFollowupContext(qs, { a: answer('a') }, ['Scope'])
  expect(context.map(({ question }) => question.id)).toEqual(['a', 'b'])
  expect(clarifyFollowupContext(qs, {}, []).map(({ question }) => question.id)).toEqual([
    'a',
    'b',
    'other',
  ])
  expect(clarifyFollowupContext(qs, {}, ['Scope', 'Missing'])).toEqual([])
  expect(clarifyContentKey(context)).not.toBe(
    clarifyContentKey(
      clarifyFollowupContext(qs, { a: { ...answer('a'), selectedOptionIndices: [1] } }, ['Scope']),
    ),
  )
})
