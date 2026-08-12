// Shared "bounce back to the owning task" navigation for the clarify-answer
// and review-decision flows.
//
// RFC-023 bugfix #8 established this for clarify: after answering, the user
// is taken to the task detail page so they immediately see the agent re-run
// kick off. The old behavior (stay on the clarify/review surface, or bounce
// to the /clarify list which had NO live WS sync) left users believing
// "nothing happened" until they manually opened the task.
//
// The review decision flow (approve / iterate / reject) had the same gap —
// submitting only invalidated the review queries and stranded the reviewer
// on the review page. This helper is the SINGLE source of truth for "go to
// the task page and prime its queries", so the three call sites
// (clarify.detail.tsx, reviews.detail.tsx, MultiDocReviewView.tsx) can't
// drift apart again.
//
// Invalidations are fire-and-forget (matching the original clarify call
// site): they kick off a background refetch so the task page is fresh the
// instant we land, covering the case where the WS `clarify.answered` /
// `review.decision_made` event is delayed or dropped. navigate() does not
// need to await them.

import { TASK_QUERY_KEYS } from '@/lib/query-keys'
import type { QueryClient } from '@tanstack/react-query'
import type { useNavigate } from '@tanstack/react-router'

type Navigate = ReturnType<typeof useNavigate>

export function goToTaskDetail(qc: QueryClient, navigate: Navigate, taskId: string): void {
  void qc.invalidateQueries({ queryKey: TASK_QUERY_KEYS.detail(taskId) })
  void qc.invalidateQueries({ queryKey: TASK_QUERY_KEYS.nodeRuns(taskId) })
  void navigate({ to: '/tasks/$id', params: { id: taskId } })
}
