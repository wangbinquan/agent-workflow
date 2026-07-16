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

import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import type { WorkflowsWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { useEffect } from 'react'
import type { WebSocketConnectionState } from './useWebSocket'
import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

export type WorkflowSyncFrame = Extract<
  WorkflowsWsMessage,
  { type: 'workflow.updated' | 'workflow.deleted' }
>

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
  /** The one submitted mutation currently awaiting its authoritative HTTP receipt. */
  inFlightMutationId?: string | null
  /** Receives the complete updated/deleted frame for the focused workflow. */
  onFrame?: (frame: WorkflowSyncFrame) => void
  enabled?: boolean
}

const RULES: WsInvalidationRules<WorkflowsWsMessage, WorkflowSyncOptions> = {
  'workflow.created': () => [['workflows']],
  'workflow.updated': (msg, ctx) => {
    const keys: QueryKey[] = []
    if (ctx.workflowId !== null && msg.workflowId === ctx.workflowId) {
      ctx.onFrame?.(msg)
      const ownEcho =
        ctx.inFlightMutationId != null && msg.clientMutationId === ctx.inFlightMutationId
      const newer = ctx.currentVersion === null || msg.version > ctx.currentVersion
      if (!ownEcho && newer) {
        keys.push(['workflows', ctx.workflowId])
        // Preserve the legacy callback contract: it only fires when a known
        // local version is strictly advanced. Reducer callers use onFrame for
        // all focused frames, including own echoes and duplicates.
        if (ctx.currentVersion !== null) ctx.onRemoteUpdate?.(msg.version)
      }
    }
    keys.push(['workflows'])
    return keys
  },
  'workflow.deleted': (msg, ctx) => {
    if (msg.workflowId === ctx.workflowId) {
      ctx.onFrame?.(msg)
      ctx.onRemoteDelete?.()
    }
    return [['workflows']]
  },
  // 'workflow.acl.updated' is deliberately unhandled — it exists for the
  // backend's per-connection visibility cache; clients re-fetch on the
  // follow-up workflow.updated instead (pre-RFC-152 behavior preserved).
}

export function useWorkflowSync(opts: WorkflowSyncOptions): WebSocketConnectionState {
  const qc = useQueryClient()
  const connectionState = useWsInvalidation<WorkflowsWsMessage, WorkflowSyncOptions>(
    (opts.enabled ?? true) ? WS_PATHS.workflows : null,
    RULES,
    opts,
  )

  // WS is a lossy notification channel, not a replay log. Every physical
  // open (initial connect, reconnect, or auth rotation) therefore triggers a
  // query reconciliation independent of frame version/mutation-id gating.
  // A late hook joining an already-open shared socket receives its current
  // epoch and runs this once as well.
  useEffect(() => {
    if (connectionState.connectionEpoch === 0 || !(opts.enabled ?? true)) return
    if (opts.workflowId !== null) {
      void qc.invalidateQueries({ queryKey: ['workflows', opts.workflowId] })
    }
    void qc.invalidateQueries({ queryKey: ['workflows'] })
  }, [connectionState.connectionEpoch, opts.enabled, opts.workflowId, qc])

  return connectionState
}
