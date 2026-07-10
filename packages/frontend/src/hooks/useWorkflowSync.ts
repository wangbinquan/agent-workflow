// Subscribe to /ws/workflows for the current editor session. When the
// active workflow gets edited from another tab (or any other client) we
// invalidate the react-query cache so the editor refetches.
//
// The hook does NOT clobber unsaved drafts automatically — the editor
// route should already track dirty state and show a toast/banner before
// merging.
//
// RFC-152 — thin wrapper over the useWsInvalidation rules table. The
// version gating (onRemoteUpdate only for strictly newer versions of the
// focused workflow) rides the rule's side-effect slot; `opts` flows in as
// the rules ctx so the callbacks stay latest without resubscribing.

import type { QueryKey } from '@tanstack/react-query'
import type { WorkflowsWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

export interface WorkflowSyncOptions {
  /** Current workflow id (null disables the version gating). */
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

const RULES: WsInvalidationRules<WorkflowsWsMessage, WorkflowSyncOptions> = {
  'workflow.created': () => [['workflows']],
  'workflow.updated': (msg, ctx) => {
    const keys: QueryKey[] = []
    if (
      ctx.workflowId !== null &&
      msg.workflowId === ctx.workflowId &&
      ctx.currentVersion !== null &&
      msg.version > ctx.currentVersion
    ) {
      keys.push(['workflows', ctx.workflowId])
      ctx.onRemoteUpdate?.(msg.version)
    }
    keys.push(['workflows'])
    return keys
  },
  'workflow.deleted': (msg, ctx) => {
    if (msg.workflowId === ctx.workflowId) {
      ctx.onRemoteDelete?.()
    }
    return [['workflows']]
  },
  // 'workflow.acl.updated' is deliberately unhandled — it exists for the
  // backend's per-connection visibility cache; clients re-fetch on the
  // follow-up workflow.updated instead (pre-RFC-152 behavior preserved).
}

export function useWorkflowSync(opts: WorkflowSyncOptions): void {
  useWsInvalidation<WorkflowsWsMessage, WorkflowSyncOptions>(
    (opts.enabled ?? true) ? WS_PATHS.workflows : null,
    RULES,
    opts,
  )
}
