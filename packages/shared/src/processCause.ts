// RFC-616 §4.1 — why one execution ran, for process metrics.
//
// A node run's `rerun_cause` (the closed RERUN_CAUSES set) says how the row was
// minted. Process metrics ask a coarser question: was this the first pass, or
// rework, and whose fault was the rework? This file is the single exhaustive
// table from the former to the latter. A new rerun cause that is not classified
// here fails to compile (`satisfies Record<RerunCause, …>`).

import type { RerunCause } from './schemas/task'

/** The seven internal classes of an execution. */
export const PROCESS_CAUSES = [
  'first',
  'review-rework',
  'clarify-rerun',
  'auto-retry',
  'cascade',
  'recovery',
  'system',
] as const
export type ProcessCause = (typeof PROCESS_CAUSES)[number]

/**
 * `null` marks a row that is not an execution at all:
 *
 * - `retry-node` / `retry-node-cascade`: placeholder rows a manual retry mints
 *   in status `failed` without ever starting them; the real re-execution is
 *   minted afterwards by the scheduler as `revival`. Counting a placeholder as
 *   an execution would invent a failure.
 * - `commit-push`: the container row; its session rows overlap it in time.
 * - park, gate, guard, skip and virtual rows: human gates are measured from the
 *   gate ledgers, the rest never ran anything.
 */
export const PROCESS_CAUSE_OF = {
  initial: 'first',
  'wrapper-init': 'first',
  'fanout-shard': 'first',
  'fanout-aggregator': 'first',
  'wg-leader-round': 'first',
  'wg-assignment': 'first',
  'wg-message-turn': 'first',
  'dw-generate': 'first',
  'review-iterate': 'review-rework',
  'review-reject': 'review-rework',
  'clarify-answer': 'clarify-rerun',
  'cross-clarify-answer': 'clarify-rerun',
  'cross-clarify-questioner-rerun': 'clarify-rerun',
  'process-retry': 'auto-retry',
  'wg-protocol-retry': 'auto-retry',
  'stale-redispatch': 'cascade',
  revival: 'recovery',
  'commit-push-session': 'system',
  'merge-resolve': 'system',
  'retry-node': null,
  'retry-node-cascade': null,
  'commit-push': null,
  'review-park': null,
  'clarify-park': null,
  'cross-clarify-park': null,
  'io-virtual': null,
  'branch-skip': null,
  'cross-clarify-guard': null,
  'wg-gate': null,
  'dw-gate': null,
} as const satisfies Record<RerunCause, ProcessCause | null>

/** The rerun cause of the placeholder a manual retry mints for the node the user picked. */
export const MANUAL_RETRY_RERUN_CAUSE = 'retry-node' satisfies RerunCause

/** A workgroup turn re-run because its output did not follow the turn protocol. */
export const WORKGROUP_PROTOCOL_RETRY_RERUN_CAUSE = 'wg-protocol-retry' satisfies RerunCause

/**
 * The six classes shown to people. Cascades and recoveries are both "another
 * run that neither a review nor a failure retry asked for".
 */
export const PROCESS_CAUSE_GROUPS = [
  'first',
  'review-rework',
  'clarify-rerun',
  'auto-retry',
  'other-rerun',
  'system',
] as const
export type ProcessCauseGroup = (typeof PROCESS_CAUSE_GROUPS)[number]

export const PROCESS_CAUSE_GROUP_OF = {
  first: 'first',
  'review-rework': 'review-rework',
  'clarify-rerun': 'clarify-rerun',
  'auto-retry': 'auto-retry',
  cascade: 'other-rerun',
  recovery: 'other-rerun',
  system: 'system',
} as const satisfies Record<ProcessCause, ProcessCauseGroup>

/**
 * What a `system` slice was for. "System work" alone tells a reader neither what
 * ran nor where to change it, so the page lists it by kind.
 *
 * The first three are the kinds the platform's own model calls are recorded with
 * when they belong to a task (`observation_calls.system_kind`); the next two are
 * the platform's own sessions inside a task, told apart by the rerun cause their
 * row was minted with. A call recorded with a kind this list does not name keeps
 * its recorded kind, so nothing is hidden behind "other".
 */
export const PROCESS_SYSTEM_WORK_KINDS = [
  'memory-distill',
  'clarify-followup',
  'change-narrative',
  'commit-push',
  'merge-resolve',
  'other',
] as const
export type ProcessSystemWorkKind = (typeof PROCESS_SYSTEM_WORK_KINDS)[number]

const SYSTEM_WORK_OF_RERUN_CAUSE = {
  'commit-push-session': 'commit-push',
  'merge-resolve': 'merge-resolve',
} as const satisfies Partial<Record<RerunCause, ProcessSystemWorkKind>>

/** The kind of a `system` execution that is a node run. */
export function processSystemWorkOfRerunCause(
  rerunCause: string | null | undefined,
): ProcessSystemWorkKind {
  return rerunCause != null && Object.hasOwn(SYSTEM_WORK_OF_RERUN_CAUSE, rerunCause)
    ? SYSTEM_WORK_OF_RERUN_CAUSE[rerunCause as keyof typeof SYSTEM_WORK_OF_RERUN_CAUSE]
    : 'other'
}

/** The kind of a `system` call: the kind it was recorded with, `other` when it carries none. */
export function processSystemWorkOfCall(systemKind: string | null | undefined): string {
  return systemKind == null || systemKind === '' ? 'other' : systemKind
}

/**
 * Classify a raw rerun cause. A missing cause (rows written before causes were
 * recorded) counts as a first execution; an unknown string (a cause this build
 * does not know) is treated the same way rather than dropped.
 */
export function processCauseOf(rerunCause: string | null | undefined): ProcessCause | null {
  if (rerunCause === null || rerunCause === undefined || rerunCause === '') return 'first'
  if (!Object.hasOwn(PROCESS_CAUSE_OF, rerunCause)) return 'first'
  return PROCESS_CAUSE_OF[rerunCause as RerunCause]
}
