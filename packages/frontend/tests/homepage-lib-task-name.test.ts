// RFC-037 T9 — locks `mergeInboxItems` carrying `taskName` from the joined
// summaries onto each preview row. Both branches (review + clarify) must
// expose `taskName` so the renderer can render a single uniform chip.

import { describe, expect, test } from 'vitest'
import { mergeInboxItems } from '@/lib/homepage'
import type { ClarifyRoundSummary, ReviewSummary } from '@agent-workflow/shared'

const REVIEW: ReviewSummary = {
  nodeRunId: 'nr-1',
  taskId: 't1',
  taskName: 'PR-1234 fix',
  workflowId: 'wf-1',
  workflowName: 'code-review',
  reviewNodeId: 'rev-1',
  title: 'Review',
  description: '',
  currentVersionIndex: 1,
  reviewIteration: 0,
  decision: 'pending',
  awaitingReview: true,
  shardKey: null,
  createdAt: 1000,
  decidedAt: null,
}

const CLARIFY: ClarifyRoundSummary = {
  id: 'c1',
  taskId: 't2',
  taskName: 'PR-9999 doc',
  kind: 'self',
  askingNodeId: 'agent-1',
  askingShardKey: null,
  intermediaryNodeId: 'clarify-1',
  intermediaryNodeRunId: 'nr-2',
  targetConsumerNodeId: null,
  loopIter: 0,
  iteration: 0,
  questionCount: 2,
  status: 'awaiting_human',
  directive: null,
  createdAt: 2000,
  answeredAt: null,
}

describe('RFC-037 — mergeInboxItems threads taskName onto preview rows', () => {
  test('review row carries taskName', () => {
    const out = mergeInboxItems([REVIEW], [])
    expect(out.length).toBe(1)
    expect(out[0]?.taskName).toBe('PR-1234 fix')
  })

  test('clarify row carries taskName', () => {
    const out = mergeInboxItems([], [CLARIFY])
    expect(out.length).toBe(1)
    expect(out[0]?.taskName).toBe('PR-9999 doc')
  })

  test('mixed merge preserves per-row taskName (no cross-contamination)', () => {
    const out = mergeInboxItems([REVIEW], [CLARIFY])
    const byKind = new Map(out.map((r) => [r.kind, r.taskName]))
    expect(byKind.get('review')).toBe('PR-1234 fix')
    expect(byKind.get('clarify')).toBe('PR-9999 doc')
  })

  test('sort newest-first still works (preview ordering unchanged)', () => {
    const out = mergeInboxItems([REVIEW], [CLARIFY])
    // CLARIFY.createdAt=2000 > REVIEW.createdAt=1000
    expect(out[0]?.kind).toBe('clarify')
  })
})
