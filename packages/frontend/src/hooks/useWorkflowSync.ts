// Subscribe to /ws/workflows for the current editor session. When the
// active workflow gets edited from another tab (or any other client) we
// invalidate the react-query cache so the editor refetches.
//
// The hook does NOT clobber unsaved drafts automatically — the editor
// route should already track dirty state and show a toast/banner before
// merging.

import { useQueryClient } from '@tanstack/react-query'
import type { WorkflowsWsMessage } from '@agent-workflow/shared'
import { useWebSocket } from './useWebSocket'

export interface WorkflowSyncOptions {
  /** Current workflow id (or null on /workflows/new). */
  workflowId: string | null
  /**
   * Latest version we have locally — incoming versions less or equal to
   * this are ignored. The caller updates this whenever the editor's
   * own save mutation succeeds.
   */
  currentVersion: number | null
  /** Notified once when a strictly newer version is broadcast for this id. */
  onRemoteUpdate?: (version: number) => void
  /** Notified when the server announces our workflow was deleted. */
  onRemoteDelete?: () => void
  enabled?: boolean
}

export function useWorkflowSync(opts: WorkflowSyncOptions): void {
  const qc = useQueryClient()
  useWebSocket({
    path: '/ws/workflows',
    enabled: opts.enabled ?? true,
    onMessage: (raw) => {
      const msg = raw as WorkflowsWsMessage
      if (msg.type === 'workflow.deleted') {
        if (msg.workflowId === opts.workflowId) {
          opts.onRemoteDelete?.()
        }
        void qc.invalidateQueries({ queryKey: ['workflows'] })
        return
      }
      if (msg.type === 'workflow.created') {
        void qc.invalidateQueries({ queryKey: ['workflows'] })
        return
      }
      if (msg.type === 'workflow.updated') {
        if (
          opts.workflowId !== null &&
          msg.workflowId === opts.workflowId &&
          opts.currentVersion !== null &&
          msg.version > opts.currentVersion
        ) {
          void qc.invalidateQueries({ queryKey: ['workflows', opts.workflowId] })
          opts.onRemoteUpdate?.(msg.version)
        }
        void qc.invalidateQueries({ queryKey: ['workflows'] })
      }
    },
  })
}
