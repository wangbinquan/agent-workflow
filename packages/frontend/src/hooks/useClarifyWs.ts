// RFC-023 PR-C T24 — focused WS subscription for the clarify detail page.
//
// useTaskSync already invalidates the clarify queries when the task-detail
// canvas is mounted; that handles the "task page tab + clarify list" case.
// But the dedicated `/clarify/$nodeRunId` page is not under /tasks and
// usually doesn't have a task subscription. This hook fills that gap: it
// subscribes to /ws/tasks/{taskId} for just the clarify.* event types and
// invalidates the three relevant query keys.
//
// `taskId` is read from the session payload — pass `null` until the page
// has loaded the session, then the hook lazily upgrades to the live
// subscription. This way the hook never opens a WS before we know which
// task to subscribe to.

import { useQueryClient } from '@tanstack/react-query'
import type { TaskWsMessage } from '@agent-workflow/shared'
import { useWebSocket } from './useWebSocket'

export interface UseClarifyWsOpts {
  /** Task id of the currently-loaded clarify round, or null while pending. */
  taskId: string | null
  /** Intermediary node_run id currently focused — used to scope the detail
   *  invalidation. RFC-058 renamed from `clarifyNodeRunId`. */
  intermediaryNodeRunId: string | null
}

export function useClarifyWs({ taskId, intermediaryNodeRunId }: UseClarifyWsOpts): void {
  const qc = useQueryClient()
  useWebSocket({
    path: taskId === null ? '' : `/ws/tasks/${encodeURIComponent(taskId)}`,
    enabled: taskId !== null,
    onMessage: (raw) => {
      const msg = raw as TaskWsMessage
      const isSelfClarify = msg.type === 'clarify.created' || msg.type === 'clarify.answered'
      const isCrossClarify =
        msg.type === 'cross-clarify.created' ||
        msg.type === 'cross-clarify.answered' ||
        msg.type === 'cross-clarify.rejected' ||
        msg.type === 'cross-clarify.designer-rerun-batched'
      if (!isSelfClarify && !isCrossClarify) return
      // Refetch the focused round detail if it's the one currently viewed.
      if (intermediaryNodeRunId !== null) {
        void qc.invalidateQueries({ queryKey: ['clarify', 'detail', intermediaryNodeRunId] })
      }
      void qc.invalidateQueries({ queryKey: ['clarify', 'list'] })
      void qc.invalidateQueries({ queryKey: ['clarify', 'pending-count'] })
    },
  })
}
