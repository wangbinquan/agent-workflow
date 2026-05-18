// RFC-037 — locks `taskName: z.string()` (required) on the two inbox summary
// schemas. Backend joins `tasks.name` at query time; the inbox / clarify list /
// reviews list all depend on the field being present. Making it optional or
// nullable would force every renderer to add fallback logic — we explicitly
// chose required to avoid that.

import { describe, expect, test } from 'bun:test'
import { ClarifySessionSummarySchema } from '../src/schemas/clarify'
import { ReviewSummarySchema } from '../src/schemas/review'

describe('ClarifySessionSummarySchema.taskName', () => {
  const base = {
    id: 'c1',
    taskId: 't1',
    sourceAgentNodeId: 'agent-1',
    sourceShardKey: null,
    clarifyNodeId: 'clarify-1',
    clarifyNodeRunId: 'nr-1',
    iterationIndex: 0,
    questionCount: 1,
    status: 'awaiting_human' as const,
    createdAt: 1,
    answeredAt: null,
  }

  test('parses when taskName is present', () => {
    const r = ClarifySessionSummarySchema.safeParse({ ...base, taskName: 'my task' })
    expect(r.success).toBe(true)
  })

  test('rejects when taskName is missing', () => {
    expect(ClarifySessionSummarySchema.safeParse(base).success).toBe(false)
  })

  // RFC-037 follow-up: optional `clarifyNodeTitle` field surfaces the
  // workflow-node display name on the inbox row. Parallel to the existing
  // `sourceAgentNodeTitle` field — must accept string / null / absent for
  // forward + backward compat.
  test('accepts clarifyNodeTitle as string, null, or absent', () => {
    expect(
      ClarifySessionSummarySchema.safeParse({
        ...base,
        taskName: 't',
        clarifyNodeTitle: 'Ask user about the DB',
      }).success,
    ).toBe(true)
    expect(
      ClarifySessionSummarySchema.safeParse({ ...base, taskName: 't', clarifyNodeTitle: null })
        .success,
    ).toBe(true)
    expect(ClarifySessionSummarySchema.safeParse({ ...base, taskName: 't' }).success).toBe(true)
  })
})

describe('ReviewSummarySchema.taskName', () => {
  const base = {
    nodeRunId: 'nr-1',
    taskId: 't1',
    workflowId: 'wf-1',
    workflowName: 'wf',
    reviewNodeId: 'review-1',
    title: 'T',
    description: '',
    currentVersionIndex: 1,
    reviewIteration: 0,
    decision: 'pending' as const,
    awaitingReview: true,
    shardKey: null,
    createdAt: 1,
    decidedAt: null,
  }

  test('parses when taskName is present', () => {
    const r = ReviewSummarySchema.safeParse({ ...base, taskName: 'my task' })
    expect(r.success).toBe(true)
  })

  test('rejects when taskName is missing', () => {
    expect(ReviewSummarySchema.safeParse(base).success).toBe(false)
  })
})
