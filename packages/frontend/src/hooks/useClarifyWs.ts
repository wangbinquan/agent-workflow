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
//
// RFC-152 — thin wrapper over the useWsInvalidation rules table. When this
// mounts next to useTaskSync on the same task, the shared-socket layer (D5)
// keeps a single physical connection. The onDraftUpdated callback rides the
// rule's side-effect slot.

import type { QueryKey } from '@tanstack/react-query'
import type { TaskWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

export interface UseClarifyWsOpts {
  /** Task id of the currently-loaded clarify round, or null while pending. */
  taskId: string | null
  /** Intermediary node_run id currently focused — used to scope the detail
   *  invalidation. RFC-058 renamed from `clarifyNodeRunId`. */
  intermediaryNodeRunId: string | null
  /** RFC-099 (D14) — fired when another member saves a draft on the focused
   *  round (frames for other node_runs are ignored). */
  onDraftUpdated?: (frame: {
    questionId: string
    editor: { userId: string; displayName: string; role: 'owner' | 'user' | 'admin' }
  }) => void
}

/** Refetch the focused round detail (if any) + the list + the badge count. */
function clarifySurface(ctx: UseClarifyWsOpts): QueryKey[] {
  const keys: QueryKey[] = []
  if (ctx.intermediaryNodeRunId !== null) {
    keys.push(['clarify', 'detail', ctx.intermediaryNodeRunId])
  }
  keys.push(['clarify', 'list'], ['clarify', 'pending-count'])
  return keys
}

// RFC-056 — cross-clarify events invalidate the same surface as the
// self-clarify pair (mixed list + focused detail + badge).
const RULES: WsInvalidationRules<TaskWsMessage, UseClarifyWsOpts> = {
  // RFC-099 (D14): collaborative draft frames — refetch the focused round
  // (brings the latest draftAnswers + per-question attribution) and let
  // the page show "X just edited question N".
  'clarify.draft.updated': (msg, ctx) => {
    if (ctx.intermediaryNodeRunId === null || msg.nodeRunId !== ctx.intermediaryNodeRunId) {
      return
    }
    ctx.onDraftUpdated?.({ questionId: msg.questionId, editor: msg.editor })
    return [['clarify', 'detail', ctx.intermediaryNodeRunId]]
  },
  'clarify.created': (_msg, ctx) => clarifySurface(ctx),
  'clarify.answered': (_msg, ctx) => clarifySurface(ctx),
  'cross-clarify.created': (_msg, ctx) => clarifySurface(ctx),
  'cross-clarify.answered': (_msg, ctx) => clarifySurface(ctx),
  'cross-clarify.rejected': (_msg, ctx) => clarifySurface(ctx),
}

export function useClarifyWs(opts: UseClarifyWsOpts): void {
  useWsInvalidation<TaskWsMessage, UseClarifyWsOpts>(
    opts.taskId === null ? null : WS_PATHS.task(opts.taskId),
    RULES,
    opts,
    { reconcileOnOpen: (ctx) => (ctx === undefined ? [] : clarifySurface(ctx)) },
  )
}
