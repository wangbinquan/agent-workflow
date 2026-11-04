// RFC-217 T9 — the task-question conflict-code enum (§8.3: 15 literals → one
// const object; the recoverable/deferrable SETS reference the enum instead of
// re-spelling strings).
//
// The string VALUES are wire/lock contract — REST clients and tests match on
// them — and must never change; this module only removes the 15-way literal
// scatter so a typo'd code fails typecheck instead of silently missing a
// recoverable-set membership test.

export const TASK_QUESTION_CONFLICT = {
  /** Entry already carries dispatched_at (double-dispatch guard). */
  alreadyDispatched: 'task-question-already-dispatched',
  /** Borrow ledger row contradicts the requested borrow transition. */
  borrowLedgerConflict: 'task-question-borrow-ledger-conflict',
  /** Designer multi-source readiness barrier: sibling rounds still awaiting. */
  designerNotReady: 'task-question-designer-not-ready',
  /** A home node already borrowed by another in-flight dispatch. */
  homeMultiBorrow: 'task-question-home-multi-borrow',
  /** The target node already has an in-flight (pending/running) rerun. */
  nodeDispatchInFlight: 'task-question-node-dispatch-in-flight',
  /** Confirm endpoint hit while the entry is not awaiting confirmation. */
  notAwaitingConfirm: 'task-question-not-awaiting-confirm',
  /** No task_questions row for the given id. */
  notFound: 'task-question-not-found',
  /** Dispatch demanded before the entry's answers were sealed. */
  notSealed: 'task-question-not-sealed',
  /** Reassign target failed validation (unknown node / self-loop / kind). */
  reassignInvalid: 'task-question-reassign-invalid',
  /** The owning clarify round row is gone (FK race / manual deletion). */
  roundMissing: 'task-question-round-missing',
  /** One round's entries resolved to more than one dispatch target. */
  roundMultiTarget: 'task-question-round-multi-target',
  /** tasks.workflow_snapshot no longer parses; no frontier can be planned. */
  snapshotUnparseable: 'task-question-snapshot-unparseable',
  /** Concurrent reassign moved the target between plan and mint. */
  targetChanged: 'task-question-target-changed',
  /** The owning task is in a terminal status. */
  terminal: 'task-question-terminal',
  /** Frontier safety veto: dispatching here would clobber unmerged work. */
  unsafeDispatchTarget: 'task-question-unsafe-dispatch-target',
} as const

export type TaskQuestionConflictCode =
  (typeof TASK_QUESTION_CONFLICT)[keyof typeof TASK_QUESTION_CONFLICT]
