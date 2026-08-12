// RFC-235 v22 — the backend is the sole source for the four business stages.
// Lock precedence here so list/detail cannot regress to generic running labels
// or diverge when multiple durable facts coexist.

import { describe, expect, test } from 'bun:test'
import {
  projectIntentJourney,
  type IntentJourneyProjectionInput,
} from '../src/services/intent/journey'

const base = (
  overrides: Partial<IntentJourneyProjectionInput> = {},
): IntentJourneyProjectionInput => ({
  status: 'active',
  contextRevision: 0,
  commitSeq: 0,
  inFlight: false,
  currentDraft: null,
  ...overrides,
})

describe('RFC-235 canonical intent journey', () => {
  test('projects each user-facing state with deterministic precedence', () => {
    expect(projectIntentJourney(base())).toEqual({
      kind: 'goal',
      step: 1,
      completedThrough: 0,
      reason: 'describe-goal',
    })
    expect(projectIntentJourney(base({ inFlight: true }))).toMatchObject({
      kind: 'generating',
      step: 2,
      reason: 'generation-running',
    })
    expect(projectIntentJourney(base({ latestAgentTurnKind: 'questions' }))).toMatchObject({
      kind: 'clarifying',
      step: 2,
      reason: 'answer-questions',
    })
    expect(
      projectIntentJourney(
        base({ currentDraft: { id: 'D1', contextRevision: 0, validationErrors: [] } }),
      ),
    ).toMatchObject({ kind: 'review-ready', step: 3, reason: 'review-draft' })
    expect(
      projectIntentJourney(
        base({ currentDraft: { id: 'D1', contextRevision: 1, validationErrors: [] } }),
      ),
    ).toMatchObject({ kind: 'review-blocked', step: 3, reason: 'draft-stale' })
    expect(
      projectIntentJourney(
        base({ currentDraft: { id: 'D1', contextRevision: 0, validationErrors: ['invalid'] } }),
      ),
    ).toMatchObject({ kind: 'review-blocked', step: 3, reason: 'draft-invalid' })
    expect(projectIntentJourney(base({ latestAgentTurnKind: 'error' }))).toMatchObject({
      kind: 'error',
      step: 2,
      reason: 'generation-failed',
    })
    expect(projectIntentJourney(base({ commitSeq: 1 }))).toEqual({
      kind: 'applied',
      step: 4,
      completedThrough: 4,
      reason: 'checkpoint-ready',
    })
    expect(
      projectIntentJourney(base({ inFlight: true, workingSetChange: { state: 'queued' } })),
    ).toMatchObject({ kind: 'generating', reason: 'working-set-queued' })
    expect(projectIntentJourney(base({ workingSetChange: { state: 'failed' } }))).toMatchObject({
      kind: 'error',
      reason: 'working-set-failed',
    })
  })

  test('apply state outranks generation and binds failure to the current draft', () => {
    const draft = { id: 'D1', contextRevision: 0, validationErrors: [] }
    expect(
      projectIntentJourney(
        base({
          inFlight: true,
          currentDraft: draft,
          latestCommit: { draftId: 'D1', state: 'applying' },
        }),
      ),
    ).toEqual({ kind: 'applying', step: 4, completedThrough: 3, reason: 'apply-running' })
    expect(
      projectIntentJourney(
        base({ currentDraft: draft, latestCommit: { draftId: 'D1', state: 'failed' } }),
      ),
    ).toEqual({ kind: 'error', step: 4, completedThrough: 3, reason: 'apply-failed' })
    expect(
      projectIntentJourney(
        base({ currentDraft: draft, latestCommit: { draftId: 'older', state: 'failed' } }),
      ),
    ).toMatchObject({ kind: 'review-ready', step: 3, reason: 'review-draft' })
  })

  test('archiving preserves the computed historical position without a current marker', () => {
    expect(
      projectIntentJourney(
        base({
          status: 'archived',
          currentDraft: { id: 'D1', contextRevision: 0, validationErrors: [] },
        }),
      ),
    ).toEqual({ kind: 'archived', step: 3, completedThrough: 2, reason: 'archived' })
    expect(projectIntentJourney(base({ status: 'archived', commitSeq: 1 }))).toEqual({
      kind: 'archived',
      step: 4,
      completedThrough: 4,
      reason: 'archived',
    })
  })
})
