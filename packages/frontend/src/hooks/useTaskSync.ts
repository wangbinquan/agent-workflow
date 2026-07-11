// Subscribe to /ws/tasks/{taskId} for the detail page. Invalidates the
// task / node-runs / diff queries on relevant events. The diff query is
// only invalidated on task.status or task.done because per-event diff
// recomputes would be expensive; tracked separately for future tuning.
//
// RFC-152 — thin wrapper over the useWsInvalidation rules table; the socket
// is shared per path (D5), so mounting this next to useClarifyWs on the
// same task keeps a single physical connection.

import type { QueryKey } from '@tanstack/react-query'
import type { TaskWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { workgroupRoomKey } from '@/lib/workgroup-room'
import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

export function useTaskSync(taskId: string | null): void {
  // task.status / task.done also re-fetch node-runs/outputs on terminal
  // transitions: the per-node status/output events may interleave with
  // task.done in either order (or drop on slower runners), so without this
  // the panel can stay stuck on "pending…" after the task heading shows
  // "done". Caught by the macOS Playwright e2e at main.spec.ts:243.
  const taskTerminal = (): QueryKey[] => [
    ['tasks', taskId],
    ['tasks', taskId, 'diff'],
    ['tasks', taskId, 'node-runs'],
    // RFC-167 PR-3: dynamic-workflow phase transitions (generating →
    // awaiting_confirm → executing) always ride a task-status flip, and the
    // dw slot lives in the room aggregate — refresh it alongside the task
    // row. Harmless for non-workgroup tasks (no active query under the key).
    workgroupRoomKey(taskId),
  ]
  // RFC-005: review.* events invalidate the per-review detail (if any tab
  // has that page open) + the list + pending-count so the sidebar badge
  // updates without waiting for the 15s poll. RFC-142: a decision / fresh
  // round also changes the round history (list expand + multi-doc
  // historical view both key off it).
  const reviewKeys = (nodeRunId: string): QueryKey[] => [
    ['reviews', 'detail', nodeRunId],
    ['reviews', 'list'],
    ['reviews', 'pending-count'],
    ['reviews', 'rounds', nodeRunId],
  ]
  // RFC-023: clarify.* events — the task-detail page may have the
  // per-session detail open; the /clarify list + the sidebar badge both
  // want a refetch when a new session is created or sealed. RFC-120: a
  // new/answered clarify round lazily collects new question entries and
  // moves their phase — refresh the board.
  const clarifyKeys = (nodeRunId: string): QueryKey[] => [
    ['clarify', 'detail', nodeRunId],
    ['clarify', 'list'],
    ['clarify', 'pending-count'],
    ['task-questions', taskId],
  ]

  const rules: WsInvalidationRules<TaskWsMessage> = {
    'task.status': () => taskTerminal(),
    'task.done': () => taskTerminal(),
    // RFC-164 PR-4 — workgroup room frames ride this same per-task channel
    // (one physical connection). Payloads are id-only by design; the rule is
    // simply "re-fetch the room aggregate" — messages, assignments and the
    // gate all live in the single GET /api/workgroup-tasks/:id/room response,
    // keyed by workgroupRoomKey (single source shared with WorkgroupRoom).
    'wg.message.created': () => [workgroupRoomKey(taskId)],
    'wg.assignment.updated': () => [workgroupRoomKey(taskId)],
    'wg.gate.updated': () => [workgroupRoomKey(taskId)],
    // RFC-120: the question board's phases derive from node_runs (handler
    // pending→running→done) — refresh it on every node status change.
    // RFC-122: reconcile the per-node clarify directive toggles on any node
    // activity (another tab's flip lands here; the acting tab is already
    // optimistic + invalidated).
    'node.status': () => [
      ['tasks', taskId, 'node-runs'],
      ['task-questions', taskId],
      ['task-clarify-directives', taskId],
    ],
    // Future: render directly on a node-events feed instead of going
    // through react-query. For now we just keep the node-runs row's
    // token usage etc. up to date.
    'node.event': () => [['tasks', taskId, 'node-runs']],
    'review.created': (msg) => reviewKeys(msg.nodeRunId),
    // The decision flip also moves the host task between statuses
    // (awaiting_review ↔ running ↔ done), so refresh that too.
    'review.decision_made': (msg) => [
      ...reviewKeys(msg.nodeRunId),
      ['tasks', taskId],
      ['tasks', taskId, 'node-runs'],
    ],
    'review.comment_added': (msg) => reviewKeys(msg.nodeRunId),
    'review.comment_deleted': (msg) => reviewKeys(msg.nodeRunId),
    // RFC-079: a multi-document item's accepted/not_accepted choice changed
    // in another tab — refresh the detail so the left-rail chips + the
    // approve gate stay in sync.
    'review.selection_changed': (msg) => reviewKeys(msg.nodeRunId),
    'clarify.created': (msg) => clarifyKeys(msg.nodeRunId),
    // RFC-123: a 'stop' answer writes the per-(task, asking-node) clarify
    // directive (the canvas toggle's single source of truth). Refresh the
    // toggles so an already-mounted canvas reflects 停止反问 immediately, not
    // only after the follow-up node.status from the rerun.
    'clarify.answered': (msg) => [
      ...clarifyKeys(msg.nodeRunId),
      ['tasks', taskId],
      ['tasks', taskId, 'node-runs'],
      ['task-clarify-directives', taskId],
    ],
    // RFC-161: cross-clarify events also invalidate node-runs so the task-detail
    // canvas's clarify-node click target (clarifyNavKind, stamped in
    // getTaskNodeRuns) stays fresh — cross-clarify parity with the self
    // `clarify.created`/`clarify.answered` refresh above. Keeps the RFC-123
    // directive invalidation (the single-source canvas toggle still needs it on
    // 'stop'). All three carry the intermediary node_run id (ws.ts).
    'cross-clarify.created': (msg) => [
      ...clarifyKeys(msg.nodeRunId),
      ['tasks', taskId, 'node-runs'],
    ],
    'cross-clarify.answered': (msg) => [
      ...clarifyKeys(msg.nodeRunId),
      ['tasks', taskId],
      ['tasks', taskId, 'node-runs'],
      ['task-clarify-directives', taskId],
    ],
    'cross-clarify.rejected': (msg) => [
      ...clarifyKeys(msg.nodeRunId),
      ['tasks', taskId],
      ['tasks', taskId, 'node-runs'],
      ['task-clarify-directives', taskId],
    ],
  }

  useWsInvalidation<TaskWsMessage>(taskId === null ? null : WS_PATHS.task(taskId), rules)
}
