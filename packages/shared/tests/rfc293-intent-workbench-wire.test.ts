// RFC-293 — the workbench wire describes product state only. In particular it
// must not grow runtime/capability fields while adding working-context and
// continuous-iteration controls.

import { describe, expect, test } from 'bun:test'
import {
  IntentComposerSourceSchema,
  IntentGenerationReceiptSchema,
  IntentWorkingSetChangeDtoSchema,
  IntentWorkingSetDeltaSchema,
  PostIntentCurrentActionSchema,
  PostIntentIterationSchema,
  PostIntentRetrySchema,
  PostIntentWorkingSetChangeSchema,
} from '../src'

const hash = `sha256:${'a'.repeat(64)}`

describe('RFC-293 Intent workbench wire', () => {
  test('accepts an ordered multi-type working-context delta without imposing a root cap', () => {
    const additions = Array.from({ length: 70 }, (_, index) => ({
      resourceType: (index % 2 === 0 ? 'agent' : 'workflow') as 'agent' | 'workflow',
      resourceId: `R${index}`,
    }))
    expect(
      PostIntentWorkingSetChangeSchema.parse({
        clientMutationId: '01JWORKINGSET00000000000000',
        expectedTurnSeq: 4,
        expectedContextRevision: 2,
        mode: 'after-current',
        delta: { additions, removals: ['res#skill#1'] },
      }).delta.additions,
    ).toHaveLength(70)
  })

  test('rejects duplicate additions, duplicate removals, empty deltas, and unknown fields', () => {
    expect(
      IntentWorkingSetDeltaSchema.safeParse({
        additions: [
          { resourceType: 'agent', resourceId: 'A1' },
          { resourceType: 'agent', resourceId: 'A1' },
        ],
        removals: [],
      }).success,
    ).toBe(false)
    expect(
      IntentWorkingSetDeltaSchema.safeParse({
        additions: [],
        removals: ['res#agent#1', 'res#agent#1'],
      }).success,
    ).toBe(false)
    expect(
      PostIntentWorkingSetChangeSchema.safeParse({
        clientMutationId: '01JWORKINGSET00000000000000',
        expectedTurnSeq: 1,
        expectedContextRevision: 0,
        mode: 'interrupt',
        delta: { additions: [], removals: [] },
      }).success,
    ).toBe(false)
    expect(
      IntentWorkingSetDeltaSchema.safeParse({
        additions: [],
        removals: [],
        capabilityPolicy: 'sealed',
      }).success,
    ).toBe(false)
  })

  test('keeps working-set DTO terminal state and result explicit', () => {
    const dto = {
      id: 'C1',
      mode: 'after-current' as const,
      state: 'applied' as const,
      delta: { additions: [{ resourceType: 'agent' as const, resourceId: 'A1' }], removals: [] },
      expectedTurnSeq: 3,
      expectedContextRevision: 1,
      resultingContextRevision: 2,
      resultingTurnId: 'T5',
      error: null,
      createdAt: 10,
      updatedAt: 11,
    }
    expect(IntentWorkingSetChangeDtoSchema.parse(dto)).toEqual(dto)
  })

  test('strictly distinguishes refine, checkpoint continuation, and regeneration', () => {
    expect(
      PostIntentIterationSchema.parse({
        mode: 'refine-current',
        clientMutationId: '01JITERATION000000000000000',
        expectedTurnSeq: 8,
        expectedContextRevision: 3,
        sourceDraftId: 'D2',
        sourceDraftHash: hash,
        feedback: 'Make the workflow easier to operate.',
      }).mode,
    ).toBe('refine-current')
    expect(
      PostIntentIterationSchema.parse({
        mode: 'continue-checkpoint',
        clientMutationId: '01JITERATION000000000000001',
        expectedTurnSeq: 11,
        expectedContextRevision: 4,
        sourceCommitSeq: 2,
        feedback: 'Add another output path.',
      }).mode,
    ).toBe('continue-checkpoint')
    expect(
      PostIntentIterationSchema.parse({
        mode: 'regenerate',
        clientMutationId: '01JITERATION000000000000002',
        expectedTurnSeq: 8,
        expectedContextRevision: 3,
        sourceDraftId: 'D2',
        sourceDraftHash: hash,
      }).mode,
    ).toBe('regenerate')
    expect(
      PostIntentIterationSchema.safeParse({
        mode: 'regenerate',
        clientMutationId: '01JITERATION000000000000002',
        expectedTurnSeq: 8,
        expectedContextRevision: 3,
        sourceDraftId: 'D2',
        sourceDraftHash: hash,
        feedback: 'silently changes regenerate semantics',
      }).success,
    ).toBe(false)
  })

  test('combines answers and mount decisions into one source-fenced action', () => {
    const action = {
      clientMutationId: '01JCURRENTACTION00000000000',
      sourceTurnId: 'T4',
      expectedTurnSeq: 4,
      expectedContextRevision: 1,
      answers: [{ id: 'q1', picked: ['A'] }],
      decisions: [{ resourceType: 'agent' as const, name: 'auditor', action: 'reject' as const }],
    }
    expect(PostIntentCurrentActionSchema.parse(action)).toEqual(action)
  })

  test('binds retry and receipts to concrete turns', () => {
    expect(
      PostIntentRetrySchema.parse({
        clientMutationId: '01JRETRY000000000000000000',
        sourceTurnId: 'T9',
        expectedTurnSeq: 9,
        expectedContextRevision: 4,
      }).sourceTurnId,
    ).toBe('T9')
    expect(
      IntentGenerationReceiptSchema.parse({
        userTurnId: 'T10',
        agentTurnId: 'T11',
        replayed: false,
      }),
    ).toEqual({ userTurnId: 'T10', agentTurnId: 'T11', replayed: false })
  })

  test('projects only the three composer sources', () => {
    expect(IntentComposerSourceSchema.parse({ kind: 'conversation' })).toEqual({
      kind: 'conversation',
    })
    expect(
      IntentComposerSourceSchema.safeParse({ kind: 'runtime-profile', name: 'anything' }).success,
    ).toBe(false)
  })
})
