// RFC-195 T1: pure inbox projection + selected-feed state machine.
//
// Keep this module free of React/i18n state: the caller supplies the one
// locale-sensitive formatter (clarify context), while row identity, sorting,
// counts, and failure-soft state remain deterministic and cheap to unit-test.

import type { ClarifyRoundSummary, ReviewSummary } from '@agent-workflow/shared'

import type { WorkgroupPendingCount } from '@/lib/workgroup-room'

export type InboxTab = 'all' | 'reviews' | 'clarify'

export interface InboxFeedSnapshot<T> {
  data: readonly T[] | undefined
  isInitialLoading: boolean
  error: unknown | null
}

export interface InboxValueFeedSnapshot<T> {
  data: T | undefined
  isInitialLoading: boolean
  error: unknown | null
}

export type InboxWorkgroupFeedSnapshot = InboxValueFeedSnapshot<WorkgroupPendingCount>

export interface InboxItem {
  kind: 'review' | 'clarify'
  /** Stable React/test row identity. Clarify deliberately uses the round id. */
  rowKey: string
  /** Route parameter: review or intermediary-clarify node-run id. */
  navigationId: string
  taskId: string
  taskName: string
  title: string
  context: string
  createdAt: number
}

export const INBOX_WORKGROUP_ROW_KEY = 'workgroups' as const

export interface InboxWorkgroupSummary {
  rowKey: typeof INBOX_WORKGROUP_ROW_KEY
  deliveries: number
  gates: number
  total: number
}

export interface InboxCounts {
  /**
   * Sum of every source that currently has data. During a partial failure this
   * is intentionally a useful subtotal; `partial` tells the UI it is not a
   * complete total.
   */
  all?: number
  reviews?: number
  clarify?: number
}

export type InboxViewState = 'loading' | 'error' | 'empty' | 'content'

export interface InboxViewModel {
  /** Current tab's review/clarify rows, newest first. */
  items: readonly InboxItem[]
  /** Current tab's count-only workgroup row; only non-null on `all` with actions. */
  workgroup: InboxWorkgroupSummary | null
  /** RFC-195 documented compatibility field; zero outside `all`. */
  workgroupTotal: number
  counts: InboxCounts
  state: InboxViewState
  /** A visible feed failed but at least one visible feed still supplied data. */
  partial: boolean
}

export interface InboxClarifyContext {
  askingAgent: string
  shardKey: string | null
  iteration: number
}

export interface DeriveInboxViewModelInput {
  tab: InboxTab
  reviews: InboxFeedSnapshot<ReviewSummary>
  clarify: InboxFeedSnapshot<ClarifyRoundSummary>
  workgroups: InboxWorkgroupFeedSnapshot
  formatClarifyContext: (context: InboxClarifyContext) => string
}

interface VisibleFeed {
  hasData: boolean
  isInitialLoading: boolean
  error: unknown | null
}

/**
 * Project the three inbox feeds into the selected tab's complete render model.
 * Data always wins over background state: cached actionable content remains
 * usable when a refetch fails or another feed is still loading.
 */
export function deriveInboxViewModel({
  tab,
  reviews,
  clarify,
  workgroups,
  formatClarifyContext,
}: DeriveInboxViewModelInput): InboxViewModel {
  const projected: InboxItem[] = []

  if (tab === 'all' || tab === 'reviews') {
    for (const review of reviews.data ?? []) {
      projected.push({
        kind: 'review',
        rowKey: review.nodeRunId,
        navigationId: review.nodeRunId,
        taskId: review.taskId,
        taskName: review.taskName,
        title: review.title,
        context: review.workflowName,
        createdAt: review.createdAt,
      })
    }
  }

  if (tab === 'all' || tab === 'clarify') {
    for (const round of clarify.data ?? []) {
      const askingAgent = nonEmptyLabel(round.askingNodeTitle, round.askingNodeId)
      projected.push({
        kind: 'clarify',
        rowKey: round.id,
        navigationId: round.intermediaryNodeRunId,
        taskId: round.taskId,
        taskName: round.taskName,
        title: nonEmptyLabel(round.intermediaryNodeTitle, round.intermediaryNodeId),
        context: formatClarifyContext({
          askingAgent,
          shardKey: round.askingShardKey === '' ? null : round.askingShardKey,
          iteration: round.iteration,
        }),
        createdAt: round.createdAt,
      })
    }
  }

  const items = stableNewestFirst(projected)
  const workgroupData = tab === 'all' ? workgroups.data : undefined
  const workgroupTotal = workgroupData?.total ?? 0
  const workgroup =
    workgroupData !== undefined && workgroupTotal > 0
      ? {
          rowKey: INBOX_WORKGROUP_ROW_KEY,
          deliveries: workgroupData.deliveries,
          gates: workgroupData.gates,
          total: workgroupTotal,
        }
      : null

  const visibleFeeds: VisibleFeed[] = []
  if (tab === 'all' || tab === 'reviews') visibleFeeds.push(toVisibleFeed(reviews))
  if (tab === 'all' || tab === 'clarify') visibleFeeds.push(toVisibleFeed(clarify))
  if (tab === 'all') visibleFeeds.push(toVisibleFeed(workgroups))

  const hasContent = items.length > 0 || workgroupTotal > 0
  const hasInitialLoading = visibleFeeds.some((feed) => feed.isInitialLoading)
  const hasError = visibleFeeds.some((feed) => feed.error !== null)
  const hasVisibleData = visibleFeeds.some((feed) => feed.hasData)

  let state: InboxViewState
  if (hasContent) state = 'content'
  else if (hasInitialLoading) state = 'loading'
  else if (hasError) state = 'error'
  else state = 'empty'

  return {
    items,
    workgroup,
    workgroupTotal,
    counts: deriveCounts(reviews, clarify, workgroups),
    state,
    partial: hasError && hasVisibleData,
  }
}

function deriveCounts(
  reviews: InboxFeedSnapshot<ReviewSummary>,
  clarify: InboxFeedSnapshot<ClarifyRoundSummary>,
  workgroups: InboxWorkgroupFeedSnapshot,
): InboxCounts {
  const reviewsCount = reviews.data?.length
  const clarifyCount = clarify.data?.length
  const workgroupCount = workgroups.data?.total
  const available = [reviewsCount, clarifyCount, workgroupCount].filter(
    (count): count is number => count !== undefined,
  )

  return {
    all: available.length > 0 ? available.reduce((total, count) => total + count, 0) : undefined,
    reviews: reviewsCount,
    clarify: clarifyCount,
  }
}

function toVisibleFeed<T>(feed: InboxFeedSnapshot<T> | InboxValueFeedSnapshot<T>): VisibleFeed {
  return {
    hasData: feed.data !== undefined,
    isInitialLoading: feed.isInitialLoading,
    error: feed.error,
  }
}

function nonEmptyLabel(label: string | null | undefined, fallback: string): string {
  return typeof label === 'string' && label.length > 0 ? label : fallback
}

/** Explicit index tie-break keeps equal-timestamp order independent of engine details. */
function stableNewestFirst(items: readonly InboxItem[]): InboxItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      if (left.item.createdAt !== right.item.createdAt) {
        return left.item.createdAt > right.item.createdAt ? -1 : 1
      }
      return left.index - right.index
    })
    .map(({ item }) => item)
}
