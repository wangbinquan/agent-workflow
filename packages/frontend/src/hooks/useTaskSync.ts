// Subscribe to /ws/tasks/{taskId} for the detail page. Invalidates the
// task / node-runs / diff queries on relevant events. The diff query is
// only invalidated on task.status or task.done because per-event diff
// recomputes would be expensive; tracked separately for future tuning.

import { useQueryClient } from '@tanstack/react-query'
import type { TaskWsMessage } from '@agent-workflow/shared'
import { useWebSocket } from './useWebSocket'

export function useTaskSync(taskId: string | null): void {
  const qc = useQueryClient()
  useWebSocket({
    path: taskId === null ? '' : `/ws/tasks/${encodeURIComponent(taskId)}`,
    enabled: taskId !== null,
    onMessage: (raw) => {
      if (taskId === null) return
      const msg = raw as TaskWsMessage
      if (msg.type === 'task.status' || msg.type === 'task.done') {
        void qc.invalidateQueries({ queryKey: ['tasks', taskId] })
        void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'diff'] })
        // Also re-fetch node-runs/outputs on terminal transitions: the
        // per-node status/output events may interleave with task.done in
        // either order (or drop on slower runners), so without this the
        // panel can stay stuck on "pending…" after the task heading shows
        // "done". Caught by the macOS Playwright e2e at main.spec.ts:243.
        void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
      }
      if (msg.type === 'node.status') {
        void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
      }
      if (msg.type === 'node.event') {
        // Future: render directly on a node-events feed instead of going
        // through react-query. For now we just keep the node-runs row's
        // token usage etc. up to date.
        void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
      }
      // RFC-005: review.* events. Invalidate the per-review detail (if
      // any tab has that page open) + the list + pending-count so the
      // sidebar badge updates without waiting for the 15s poll.
      if (
        msg.type === 'review.created' ||
        msg.type === 'review.decision_made' ||
        msg.type === 'review.comment_added' ||
        msg.type === 'review.comment_deleted' ||
        // RFC-079: a multi-document item's accepted/not_accepted choice changed
        // in another tab — refresh the detail so the left-rail chips + the
        // approve gate stay in sync.
        msg.type === 'review.selection_changed'
      ) {
        void qc.invalidateQueries({ queryKey: ['reviews', 'detail', msg.nodeRunId] })
        void qc.invalidateQueries({ queryKey: ['reviews', 'list'] })
        void qc.invalidateQueries({ queryKey: ['reviews', 'pending-count'] })
        // The decision flip also moves the host task between statuses
        // (awaiting_review ↔ running ↔ done), so refresh that too.
        if (msg.type === 'review.decision_made') {
          void qc.invalidateQueries({ queryKey: ['tasks', taskId] })
          void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
        }
      }
      // RFC-023: clarify.* events. Same shape as the review block — the
      // task-detail page may have the per-session detail open; the
      // /clarify list + the sidebar badge both want a refetch when a new
      // session is created or sealed.
      if (msg.type === 'clarify.created' || msg.type === 'clarify.answered') {
        void qc.invalidateQueries({ queryKey: ['clarify', 'detail', msg.nodeRunId] })
        void qc.invalidateQueries({ queryKey: ['clarify', 'list'] })
        void qc.invalidateQueries({ queryKey: ['clarify', 'pending-count'] })
        if (msg.type === 'clarify.answered') {
          void qc.invalidateQueries({ queryKey: ['tasks', taskId] })
          void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
        }
      }
    },
  })
}
