// RFC-372 review follow-up O4 (design/RFC-372-mindmap-clarify/review-followups-20261014.md):
// content keys (confirmations, question-set keys, follow-up bases) no longer depend on
// property insertion order, so a re-parsed or re-spread question keeps its identity.
import { describe, expect, test } from 'bun:test'
import {
  ClarifyQuestionSchema,
  canonicalClarifyJson,
  clarifyAnswerBasis,
  clarifyContentKey,
  clarifyQuestionSetKey,
  isClarifyAnswerConfirmed,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from '../src'

const question = ClarifyQuestionSchema.parse({
  id: 'scope',
  title: 'Which scope?',
  kind: 'single',
  options: ['A', 'B'],
  mindmap: { categoryPath: ['Scope'] },
})
// The same question with every level of properties built in another order.
const reordered = Object.fromEntries(
  Object.entries(question)
    .reverse()
    .map(([key, value]) =>
      key === 'mindmap' && value && typeof value === 'object'
        ? [key, Object.fromEntries(Object.entries(value).reverse())]
        : [key, value],
    ),
) as unknown as ClarifyQuestion
const answer = (confirmedBasis?: string): ClarifyAnswer => ({
  questionId: 'scope',
  selectedOptionIndices: [0],
  selectedOptionLabels: [],
  customText: '',
  ...(confirmedBasis ? { confirmedBasis } : {}),
})

describe('RFC-372 review O4: canonical content keys', () => {
  test('object key order never changes a key; array order and values still do', () => {
    expect(canonicalClarifyJson({ b: 1, a: { d: [2, 1], c: undefined } })).toBe(
      '{"a":{"d":[2,1]},"b":1}',
    )
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(question))
    expect(clarifyContentKey(reordered)).toBe(clarifyContentKey(question))
    expect(clarifyQuestionSetKey([reordered])).toBe(clarifyQuestionSetKey([question]))
    expect(clarifyContentKey([1, 2])).not.toBe(clarifyContentKey([2, 1]))
    expect(clarifyContentKey({ ...question, title: 'Other' })).not.toBe(clarifyContentKey(question))
    expect(clarifyQuestionSetKey([question])).toMatch(/^v2:[0-9a-f]{32}$/)
  })

  test('a confirmation survives a reordered question and is lost when the answer changes', () => {
    const confirmed = answer(clarifyAnswerBasis(question, answer()))
    expect(confirmed.confirmedBasis).toMatch(/^v2:/)
    expect(isClarifyAnswerConfirmed(question, confirmed)).toBe(true)
    expect(isClarifyAnswerConfirmed(reordered, confirmed)).toBe(true)
    expect(isClarifyAnswerConfirmed(question, { ...confirmed, selectedOptionIndices: [1] })).toBe(
      false,
    )
  })
})
