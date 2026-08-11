// RFC-235 v22 — locks the canonical four-step read model and the source-bound
// mount decision/receipt wire. These DTOs drive permissions and controls in
// the frontend, so permissive extras or contradictory journey fields fail.

import { describe, expect, test } from 'bun:test'
import {
  IntentJourneySnapshotSchema,
  IntentDraftDtoSchema,
  IntentMountApprovalReceiptSchema,
  IntentMountSuggestionBatchSchema,
  IntentSessionListPageSchema,
  PostIntentMountApprovalsSchema,
} from '../src'

const summary = {
  id: 'S1',
  title: 'Build an audit workflow',
  status: 'active' as const,
  contextRevision: 0,
  turnSeq: 2,
  commitSeq: 0,
  inFlight: true,
  currentDraftRevision: null,
  journey: {
    kind: 'generating' as const,
    step: 2 as const,
    completedThrough: 1 as const,
    reason: 'generation-running' as const,
  },
  createdAt: 1,
  updatedAt: 2,
}

const receipt = {
  sourceTurnId: 'T2',
  sourceTurnSeq: 2,
  approvalTurnId: 'T3',
  approvalTurnSeq: 3,
  resultingContextRevision: 1,
  approved: [
    {
      resourceType: 'agent' as const,
      name: 'auditor',
      resourceId: 'A1',
      handle: 'res#agent#1',
    },
  ],
  rejected: [{ resourceType: 'workflow' as const, name: 'missing-workflow' }],
}

describe('RFC-235 v22 intent UX wire', () => {
  test('accepts every canonical journey position, including archived history', () => {
    const states = [
      { kind: 'goal', step: 1, completedThrough: 0, reason: 'describe-goal' },
      { kind: 'generating', step: 2, completedThrough: 1, reason: 'generation-running' },
      { kind: 'clarifying', step: 2, completedThrough: 1, reason: 'answer-questions' },
      { kind: 'review-ready', step: 3, completedThrough: 2, reason: 'review-draft' },
      { kind: 'review-blocked', step: 3, completedThrough: 2, reason: 'draft-stale' },
      { kind: 'review-blocked', step: 3, completedThrough: 2, reason: 'draft-invalid' },
      { kind: 'applying', step: 4, completedThrough: 3, reason: 'apply-running' },
      { kind: 'applied', step: 4, completedThrough: 4, reason: 'applied' },
      { kind: 'error', step: 2, completedThrough: 1, reason: 'generation-failed' },
      { kind: 'error', step: 4, completedThrough: 3, reason: 'apply-failed' },
      { kind: 'archived', step: 3, completedThrough: 2, reason: 'archived' },
    ]
    for (const state of states)
      expect(IntentJourneySnapshotSchema.safeParse(state).success).toBe(true)
  })

  test('rejects contradictory or extended journey and list shapes', () => {
    expect(
      IntentJourneySnapshotSchema.safeParse({
        kind: 'applied',
        step: 2,
        completedThrough: 1,
        reason: 'generation-running',
      }).success,
    ).toBe(false)
    expect(
      IntentJourneySnapshotSchema.safeParse({ ...summary.journey, rawStatus: 'running' }).success,
    ).toBe(false)
    expect(
      IntentSessionListPageSchema.safeParse({
        items: [{ ...summary, ownerEmail: 'private@example.test' }],
        nextCursor: null,
      }).success,
    ).toBe(false)
    expect(
      IntentSessionListPageSchema.safeParse({ items: [summary], nextCursor: null, total: 1 })
        .success,
    ).toBe(false)
    expect(
      IntentDraftDtoSchema.safeParse({
        id: 'D1',
        revision: 1,
        changeset: {},
        validation: { errors: [], credentialFindings: [] },
        slots: [],
        draftHash: `sha256:${'a'.repeat(64)}`,
        contextRevision: 0,
        stale: false,
        createdAt: 1,
        internalPrompt: 'must never drift into the UX wire',
      }).success,
    ).toBe(false)
  })

  test('strictly binds every mount decision and receipt item to its source shape', () => {
    expect(IntentMountApprovalReceiptSchema.parse(receipt)).toEqual(receipt)
    expect(
      IntentMountApprovalReceiptSchema.safeParse({
        ...receipt,
        approved: [{ ...receipt.approved[0], ownerUserId: 'U1' }],
      }).success,
    ).toBe(false)
    expect(
      PostIntentMountApprovalsSchema.safeParse({
        sourceTurnId: 'T2',
        expectedTurnSeq: 2,
        expectedContextRevision: 0,
        decisions: [
          {
            resourceType: 'agent',
            name: 'auditor',
            action: 'reject',
            resourceId: 'A1',
          },
        ],
      }).success,
    ).toBe(false)
  })

  test('keeps mount candidates actor-safe and strict at every nesting level', () => {
    const batch = {
      sourceTurnId: 'T2',
      sourceTurnSeq: 2,
      contextRevision: 0,
      items: [
        {
          resourceType: 'agent' as const,
          name: 'auditor',
          reason: 'reuse the existing auditor',
          candidates: [{ resourceId: 'A1', name: 'auditor', description: 'Visible description' }],
        },
      ],
    }
    expect(IntentMountSuggestionBatchSchema.parse(batch)).toEqual(batch)
    expect(
      IntentMountSuggestionBatchSchema.safeParse({
        ...batch,
        items: [
          {
            ...batch.items[0],
            candidates: [{ ...batch.items[0]!.candidates[0], visibility: 'private' }],
          },
        ],
      }).success,
    ).toBe(false)
  })
})
