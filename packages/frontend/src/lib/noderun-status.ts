// Maps a node_run row to a user-facing status label / classifier. Exists
// because RFC-011's review iterate / reject path repurposes the `canceled`
// status to mean "this attempt has been replaced by a newer retry" — but
// users read raw `canceled` as "I cancelled it manually". The right label
// depends on whether the worktree files were actually rolled back:
//
//   - `superseded-by-review-{decision}-rollback:` — files reset to the
//     pre-attempt snapshot, this attempt is genuinely undone → "Canceled".
//   - `superseded-by-review-{decision}:` — files kept, only a fresh retry
//     was minted alongside → "Superseded" (the more accurate label).
//
// The marker is encoded into `errorMessage` by services/review.ts; tests in
// reviews-iterate-mints-new-run.test.ts lock both shapes. Keep this helper
// in lock-step with that file's marker format.

import type { NodeRun, NodeRunStatus } from '@agent-workflow/shared'
import type { StatusChipKind } from '@/components/StatusChip'

const PREFIX_PLAIN_ITERATE = 'superseded-by-review-iterated:'
const PREFIX_PLAIN_REJECT = 'superseded-by-review-rejected:'
const PREFIX_ROLLBACK_ITERATE = 'superseded-by-review-iterated-rollback:'
const PREFIX_ROLLBACK_REJECT = 'superseded-by-review-rejected-rollback:'

export type CanceledKind = 'manual' | 'superseded' | 'rollback'

/**
 * Classify a `canceled` node_run row by its supersede marker.
 *   - 'rollback'   — review decision caused rollbackToSnapshot to succeed;
 *                    the row is effectively a true cancellation.
 *   - 'superseded' — review decision minted a fresh retry but kept files;
 *                    this row is alive in the prompt-history switcher only.
 *   - 'manual'     — every other case (incl. status !== 'canceled', null
 *                    errorMessage, or unrelated cancellation reason). The
 *                    UI should fall back to the raw status label.
 */
export function classifyCanceled(run: NodeRun): CanceledKind {
  if (run.status !== 'canceled') return 'manual'
  const msg = run.errorMessage ?? ''
  if (msg.startsWith(PREFIX_ROLLBACK_ITERATE) || msg.startsWith(PREFIX_ROLLBACK_REJECT)) {
    return 'rollback'
  }
  if (msg.startsWith(PREFIX_PLAIN_ITERATE) || msg.startsWith(PREFIX_PLAIN_REJECT)) {
    return 'superseded'
  }
  return 'manual'
}

/**
 * The review decision that produced this supersede marker — needed by
 * the hint i18n string ("after review iterate" / "after review reject").
 * Returns null when classifyCanceled !== 'superseded' / 'rollback'.
 */
export function supersededDecision(run: NodeRun): 'iterated' | 'rejected' | null {
  if (run.status !== 'canceled') return null
  const msg = run.errorMessage ?? ''
  if (msg.startsWith(PREFIX_ROLLBACK_ITERATE) || msg.startsWith(PREFIX_PLAIN_ITERATE)) {
    return 'iterated'
  }
  if (msg.startsWith(PREFIX_ROLLBACK_REJECT) || msg.startsWith(PREFIX_PLAIN_REJECT)) {
    return 'rejected'
  }
  return null
}

/**
 * The i18n key the UI should pass to `t()` for this row's status chip.
 * Superseded rows get the friendly 'noderunStatus.superseded' label;
 * everything else (incl. rollback-canceled — which IS a real cancellation)
 * goes through the per-status table so 'canceled' still renders as
 * "Canceled / 已取消".
 */
export function displayNoderunStatusKey(run: NodeRun): string {
  if (classifyCanceled(run) === 'superseded') return 'noderunStatus.superseded'
  return statusKeyForRawStatus(run.status)
}

export function statusKeyForRawStatus(s: NodeRunStatus): string {
  return `noderunStatus.${s}`
}

/**
 * flag-audit W0 (§4.6) — single source of truth for NodeRunStatus → chip kind.
 * Replaces three drifted per-file `noderunTone`/`toneFor` switches
 * (routes/tasks.detail.tsx / NodeDetailDrawer.tsx / node-session/SessionTab.tsx)
 * that had already disagreed on `interrupted` (amber in the task table, gray in
 * the drawer). Canonical choice: `interrupted` is 'warn' — same semantics as
 * the task-level TASK_STATUS_KIND (lib/task-status.ts).
 */
export const NODE_RUN_STATUS_KIND: Record<NodeRunStatus, StatusChipKind> = {
  pending: 'neutral',
  running: 'info',
  done: 'success',
  failed: 'danger',
  canceled: 'neutral',
  interrupted: 'warn',
  skipped: 'neutral',
  exhausted: 'danger',
  awaiting_review: 'warn',
  awaiting_human: 'warn',
}

export function nodeRunStatusToKind(s: NodeRunStatus): StatusChipKind {
  return NODE_RUN_STATUS_KIND[s]
}
