// RFC-195 T1 — locks the pure inbox projection/state machine before the
// Dialog component consumes it. In particular, a failed feed must never hide
// another feed's actionable data or masquerade as an empty inbox.

import { describe, expect, test } from 'vitest'
import type { ClarifyRoundSummary, ReviewSummary } from '@agent-workflow/shared'

import {
  INBOX_WORKGROUP_ROW_KEY,
  deriveInboxViewModel,
  type DeriveInboxViewModelInput,
  type InboxFeedSnapshot,
  type InboxTab,
  type InboxWorkgroupFeedSnapshot,
} from '@/lib/inbox-view'
import type { WorkgroupPendingCount } from '@/lib/workgroup-room'

function review(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    nodeRunId: 'review-run-1',
    taskId: 'task-review',
    taskName: 'Review task',
    workflowId: 'workflow-1',
    workflowName: 'Code to audit',
    reviewNodeId: 'review-node',
    title: 'Review the patch',
    description: '',
    currentVersionIndex: 1,
    reviewIteration: 0,
    decision: 'pending',
    awaitingReview: true,
    shardKey: null,
    createdAt: 1_700_000_000_000,
    decidedAt: null,
    ...overrides,
  }
}

function clarify(overrides: Partial<ClarifyRoundSummary> = {}): ClarifyRoundSummary {
  return {
    id: 'clarify-round-1',
    taskId: 'task-clarify',
    taskName: 'Clarify task',
    kind: 'self',
    askingNodeId: 'asking-agent',
    askingNodeTitle: 'Planner',
    askingShardKey: null,
    intermediaryNodeId: 'clarify-node',
    intermediaryNodeTitle: 'Choose a rollout strategy',
    intermediaryNodeRunId: 'clarify-run-1',
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: 2,
    questionCount: 1,
    status: 'awaiting_human',
    directive: null,
    createdAt: 1_700_000_100_000,
    answeredAt: null,
    ...overrides,
  }
}

function listFeed<T>(
  data: readonly T[] | undefined,
  options: { loading?: boolean; error?: unknown | null } = {},
): InboxFeedSnapshot<T> {
  return {
    data,
    isInitialLoading: options.loading ?? false,
    error: options.error ?? null,
  }
}

function workgroupFeed(
  data: WorkgroupPendingCount | undefined,
  options: { loading?: boolean; error?: unknown | null } = {},
): InboxWorkgroupFeedSnapshot {
  return {
    data,
    isInitialLoading: options.loading ?? false,
    error: options.error ?? null,
  }
}

const NO_WORKGROUPS: WorkgroupPendingCount = { deliveries: 0, gates: 0, total: 0 }

function derive(overrides: Partial<Omit<DeriveInboxViewModelInput, 'formatClarifyContext'>> = {}) {
  return deriveInboxViewModel({
    tab: 'all',
    reviews: listFeed<ReviewSummary>([]),
    clarify: listFeed<ClarifyRoundSummary>([]),
    workgroups: workgroupFeed(NO_WORKGROUPS),
    formatClarifyContext: ({ askingAgent, shardKey, iteration }) =>
      `${askingAgent} · ${shardKey === null ? `iteration ${iteration}` : `shard ${shardKey}`}`,
    ...overrides,
  })
}

describe('RFC-195 inbox item projection, filter, and stable sort', () => {
  test('projects review/clarify route identity and context, then sorts newest first', () => {
    const model = derive({
      reviews: listFeed([
        review({
          nodeRunId: 'review-old',
          workflowName: 'Security workflow',
          createdAt: 100,
        }),
      ]),
      clarify: listFeed([
        clarify({
          id: 'round-new',
          intermediaryNodeRunId: 'clarify-nav-new',
          askingNodeTitle: 'Auditor',
          askingShardKey: 'src/api.ts',
          createdAt: 200,
        }),
      ]),
    })

    expect(model.items.map((item) => `${item.kind}:${item.rowKey}`)).toEqual([
      'clarify:round-new',
      'review:review-old',
    ])
    expect(model.items[0]).toMatchObject({
      navigationId: 'clarify-nav-new',
      title: 'Choose a rollout strategy',
      context: 'Auditor · shard src/api.ts',
    })
    expect(model.items[1]).toMatchObject({
      navigationId: 'review-old',
      context: 'Security workflow',
    })
  })

  test('equal timestamps preserve projection order explicitly', () => {
    const at = 123
    const model = derive({
      reviews: listFeed([
        review({ nodeRunId: 'review-a', createdAt: at }),
        review({ nodeRunId: 'review-b', createdAt: at }),
      ]),
      clarify: listFeed([
        clarify({ id: 'clarify-a', intermediaryNodeRunId: 'nav-a', createdAt: at }),
        clarify({ id: 'clarify-b', intermediaryNodeRunId: 'nav-b', createdAt: at }),
      ]),
    })

    expect(model.items.map((item) => item.rowKey)).toEqual([
      'review-a',
      'review-b',
      'clarify-a',
      'clarify-b',
    ])
  })

  test.each<{ tab: InboxTab; expectedKinds: string[] }>([
    { tab: 'all', expectedKinds: ['clarify', 'review'] },
    { tab: 'reviews', expectedKinds: ['review'] },
    { tab: 'clarify', expectedKinds: ['clarify'] },
  ])('$tab selects only its visible list feeds', ({ tab, expectedKinds }) => {
    const model = derive({
      tab,
      reviews: listFeed([review({ createdAt: 100 })]),
      clarify: listFeed([clarify({ createdAt: 200 })]),
    })
    expect(model.items.map((item) => item.kind)).toEqual(expectedKinds)
  })

  test('clarify labels fall back to ids and long source data is never truncated', () => {
    const longTitle = 'T'.repeat(128)
    const longTaskName = 'N'.repeat(128)
    const model = derive({
      clarify: listFeed([
        clarify({
          intermediaryNodeTitle: null,
          intermediaryNodeId: longTitle,
          askingNodeTitle: '',
          askingNodeId: 'agent-fallback',
          taskName: longTaskName,
        }),
      ]),
    })

    expect(model.items[0]).toMatchObject({
      title: longTitle,
      taskName: longTaskName,
      context: 'agent-fallback · iteration 2',
    })
  })
})

describe('RFC-195 counts and workgroup all-only projection', () => {
  test('counts all sources and gives the all-tab workgroup row a stable identity', () => {
    const model = derive({
      reviews: listFeed([review(), review({ nodeRunId: 'review-run-2' })]),
      clarify: listFeed([clarify()]),
      workgroups: workgroupFeed({ deliveries: 2, gates: 1, total: 3 }),
    })

    expect(model.counts).toEqual({ all: 6, reviews: 2, clarify: 1 })
    expect(model.workgroupTotal).toBe(3)
    expect(model.workgroup).toEqual({
      rowKey: INBOX_WORKGROUP_ROW_KEY,
      deliveries: 2,
      gates: 1,
      total: 3,
    })
  })

  test('all count remains a successful-source subtotal during a partial failure', () => {
    const model = derive({
      reviews: listFeed([review(), review({ nodeRunId: 'review-run-2' })]),
      clarify: listFeed<ClarifyRoundSummary>(undefined, { error: new Error('clarify down') }),
      workgroups: workgroupFeed({ deliveries: 1, gates: 2, total: 3 }),
    })

    expect(model.counts).toEqual({ all: 5, reviews: 2, clarify: undefined })
    expect(model.state).toBe('content')
    expect(model.partial).toBe(true)
  })

  test('a count is undefined only while no data for that source exists', () => {
    const none = derive({
      reviews: listFeed<ReviewSummary>(undefined, { loading: true }),
      clarify: listFeed<ClarifyRoundSummary>(undefined, { loading: true }),
      workgroups: workgroupFeed(undefined, { loading: true }),
    })
    expect(none.counts).toEqual({ all: undefined, reviews: undefined, clarify: undefined })

    const cachedError = derive({
      reviews: listFeed([review()], { error: new Error('refetch failed') }),
    })
    expect(cachedError.counts.reviews).toBe(1)
    expect(cachedError.counts.all).toBe(1)
  })

  test.each<InboxTab>(['reviews', 'clarify'])(
    'workgroup aggregation is hidden and does not create content on %s',
    (tab) => {
      const model = derive({
        tab,
        workgroups: workgroupFeed({ deliveries: 4, gates: 1, total: 5 }),
      })
      expect(model.workgroup).toBeNull()
      expect(model.workgroupTotal).toBe(0)
      expect(model.state).toBe('empty')
    },
  )
})

describe('RFC-195 selected-feed state truth table', () => {
  test.each<{
    name: string
    reviews: InboxFeedSnapshot<ReviewSummary>
    clarify: InboxFeedSnapshot<ClarifyRoundSummary>
    workgroups: InboxWorkgroupFeedSnapshot
    expectedState: 'loading' | 'error' | 'empty' | 'content'
    expectedPartial: boolean
  }>([
    {
      name: 'zero content + initial loading → loading',
      reviews: listFeed<ReviewSummary>(undefined, { loading: true }),
      clarify: listFeed([]),
      workgroups: workgroupFeed(NO_WORKGROUPS),
      expectedState: 'loading',
      expectedPartial: false,
    },
    {
      name: 'zero content + all feeds failed → error',
      reviews: listFeed<ReviewSummary>(undefined, { error: new Error('reviews') }),
      clarify: listFeed<ClarifyRoundSummary>(undefined, { error: new Error('clarify') }),
      workgroups: workgroupFeed(undefined, { error: new Error('workgroups') }),
      expectedState: 'error',
      expectedPartial: false,
    },
    {
      name: 'zero content + one failed and other feeds settled → error, never empty',
      reviews: listFeed<ReviewSummary>(undefined, { error: new Error('reviews') }),
      clarify: listFeed([]),
      workgroups: workgroupFeed(NO_WORKGROUPS),
      expectedState: 'error',
      expectedPartial: true,
    },
    {
      name: 'zero content + settled without errors → empty',
      reviews: listFeed([]),
      clarify: listFeed([]),
      workgroups: workgroupFeed(NO_WORKGROUPS),
      expectedState: 'empty',
      expectedPartial: false,
    },
    {
      name: 'content + refetch errors → content plus partial',
      reviews: listFeed([review()], { error: new Error('cached review refetch') }),
      clarify: listFeed<ClarifyRoundSummary>(undefined, { error: new Error('clarify') }),
      workgroups: workgroupFeed(undefined, { error: new Error('workgroups') }),
      expectedState: 'content',
      expectedPartial: true,
    },
    {
      name: 'content + no errors → content',
      reviews: listFeed([]),
      clarify: listFeed([clarify()]),
      workgroups: workgroupFeed(NO_WORKGROUPS),
      expectedState: 'content',
      expectedPartial: false,
    },
  ])('$name', ({ reviews, clarify, workgroups, expectedState, expectedPartial }) => {
    const model = derive({ reviews, clarify, workgroups })
    expect(model.state).toBe(expectedState)
    expect(model.partial).toBe(expectedPartial)
  })

  test('partial errors preserve every actionable row and workgroup action', () => {
    const model = derive({
      reviews: listFeed([review({ nodeRunId: 'still-actionable' })]),
      clarify: listFeed<ClarifyRoundSummary>(undefined, { error: new Error('clarify down') }),
      workgroups: workgroupFeed({ deliveries: 1, gates: 0, total: 1 }),
    })

    expect(model.items.map((item) => item.rowKey)).toEqual(['still-actionable'])
    expect(model.workgroupTotal).toBe(1)
    expect(model.state).toBe('content')
    expect(model.partial).toBe(true)
  })

  test('hidden feed loading/errors do not affect reviews or clarify state', () => {
    const reviews = derive({
      tab: 'reviews',
      reviews: listFeed([]),
      clarify: listFeed<ClarifyRoundSummary>(undefined, { loading: true }),
      workgroups: workgroupFeed(undefined, { error: new Error('hidden workgroups') }),
    })
    expect(reviews.state).toBe('empty')
    expect(reviews.partial).toBe(false)

    const clarifyModel = derive({
      tab: 'clarify',
      reviews: listFeed<ReviewSummary>(undefined, { error: new Error('hidden reviews') }),
      clarify: listFeed([clarify()]),
      workgroups: workgroupFeed(undefined, { loading: true }),
    })
    expect(clarifyModel.state).toBe('content')
    expect(clarifyModel.partial).toBe(false)
  })
})
