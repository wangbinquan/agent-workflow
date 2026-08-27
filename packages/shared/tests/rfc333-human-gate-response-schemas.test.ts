import { describe, expect, test } from 'bun:test'
import {
  DispatchTaskQuestionsResponseSchema,
  SubmitClarifyAnswersResponseSchema,
  SubmitReviewDecisionResponseSchema,
} from '../src'

const receipt = {
  operationId: 'operation-333',
  gate: { kind: 'review' as const, ref: 'review:node-1' },
  gateRevision: 2,
  taskRevision: 3,
  acceptedAt: 1_788_969_900_000,
  replayed: false,
}

describe('RFC-333 public human-gate response schemas', () => {
  test('review, clarify and questions expose a durable receipt and strip internal resume data', () => {
    const review = SubmitReviewDecisionResponseSchema.parse({
      ok: true,
      taskId: 'task-1',
      reviewIteration: 1,
      receipt,
      commentsAdded: 0,
      commentsSkippedAsDuplicate: 0,
      selectionsApplied: 0,
      resume: { ok: false, code: 'legacy', message: 'legacy' },
    })
    const clarify = SubmitClarifyAnswersResponseSchema.parse({
      ok: true,
      kind: 'autodispatch',
      taskId: 'task-1',
      receipt: { ...receipt, gate: { kind: 'clarify', ref: 'clarify:node-1' } },
      roundKind: 'self',
      sealedQuestionIds: ['q1'],
      roundFullySealed: true,
      reruns: [],
      dispatchedEntryIds: [],
      deferred: [],
      resume: { ok: false, code: 'legacy', message: 'legacy' },
    })
    const questions = DispatchTaskQuestionsResponseSchema.parse({
      ok: true,
      taskId: 'task-1',
      receipt: { ...receipt, gate: { kind: 'questions', ref: 'questions:task-1' } },
      reruns: [],
      dispatchedEntryIds: [],
      deferred: [],
      resume: { ok: false, code: 'legacy', message: 'legacy' },
    })

    expect(review).not.toHaveProperty('resume')
    expect(clarify).not.toHaveProperty('resume')
    expect(questions).not.toHaveProperty('resume')
  })

  test('clarify control-channel seal remains a supported non-release response', () => {
    expect(
      SubmitClarifyAnswersResponseSchema.parse({
        ok: true,
        kind: 'seal',
        sealedQuestionIds: ['q1'],
        resealedQuestionIds: [],
        roundFullySealed: false,
      }),
    ).toEqual({
      ok: true,
      kind: 'seal',
      sealedQuestionIds: ['q1'],
      resealedQuestionIds: [],
      roundFullySealed: false,
    })
  })
})
