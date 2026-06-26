// RFC-053 PR-B P-1 — node_run.status state machine.
//
// Codifies the lifecycle of a `node_runs` row as an explicit (status, event)
// → status transition table. Every site that writes `node_runs.status` is
// supposed to go through `transitionNodeRunStatus()` (backend) or call
// `nextNodeRunStatus()` directly (pure / tests). Illegal transitions throw
// at the service layer, never reach the DB.
//
// New status or new event? Add it to the union here and the `switch` in
// `nextNodeRunStatus` will fail at compile time (`never` exhaustiveness)
// until you fill in the transition.

// ---------------------------------------------------------------------------
// Status universe — re-export from schemas/task (the DB-authoritative one).
// ---------------------------------------------------------------------------

import { NODE_RUN_STATUS, type NodeRunStatus, TASK_STATUS, type TaskStatus } from './schemas/task'

/** Terminal statuses: once a row reaches one of these, no out-transition is legal. */
export const TERMINAL_NODE_RUN_STATUSES = [
  'done',
  'failed',
  'canceled',
  'interrupted',
  'skipped',
  'exhausted',
] as const satisfies readonly NodeRunStatus[]

export function isTerminalNodeRunStatus(s: NodeRunStatus): boolean {
  return (TERMINAL_NODE_RUN_STATUSES as readonly NodeRunStatus[]).includes(s)
}

// ---------------------------------------------------------------------------
// Events: each one identifies a specific business transition.
// ---------------------------------------------------------------------------

export type NodeRunTransitionEvent =
  // runner lifecycle
  | { kind: 'mark-running' } // pending → running
  | { kind: 'mark-done' } // running → done
  | { kind: 'mark-failed'; reason?: string } // pending|running|awaiting_* → failed
  | { kind: 'mark-canceled'; reason?: string } // any non-terminal → canceled
  | { kind: 'mark-interrupted' } // any non-terminal → interrupted
  // review flow
  | { kind: 'park-review' } // pending|running → awaiting_review
  | { kind: 'approve-review' } // awaiting_review → done
  | { kind: 'iterate-review' } // awaiting_review → pending
  | { kind: 'reject-review' } // awaiting_review → pending
  // clarify flow
  | { kind: 'park-human' } // pending|running → awaiting_human
  | { kind: 'resume-clarify' } // awaiting_human → done (clarify run closes when answers land)
  // supersede / fan-out / loop
  | { kind: 'cancel-by-supersede'; reason: string } // pending|running|awaiting_* → canceled
  | { kind: 'mark-skipped'; reason?: string } // pending → skipped
  | { kind: 'mark-exhausted' } // running → exhausted

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export class IllegalNodeRunTransition extends Error {
  readonly code = 'illegal-node-run-transition' as const
  constructor(
    readonly from: NodeRunStatus,
    readonly eventKind: NodeRunTransitionEvent['kind'],
    extra?: string,
  ) {
    super(
      `illegal node_run transition: from='${from}' via event='${eventKind}'${extra ? ` (${extra})` : ''}`,
    )
  }
}

// ---------------------------------------------------------------------------
// The transition function — single source of truth.
// ---------------------------------------------------------------------------

/**
 * Compute the next status for `cur` under event `ev`. Throws
 * IllegalNodeRunTransition if the transition is not allowed.
 *
 * All terminal `cur` values throw immediately — terminals have no
 * out-transitions. If a path needs to "rewrite" a terminal row (e.g.,
 * fixup scripts), use the lower-level `setNodeRunStatus({ allowedFrom })`
 * helper with an explicit allowlist.
 */
export function nextNodeRunStatus(cur: NodeRunStatus, ev: NodeRunTransitionEvent): NodeRunStatus {
  if (isTerminalNodeRunStatus(cur)) {
    throw new IllegalNodeRunTransition(cur, ev.kind, 'cur is terminal')
  }
  switch (ev.kind) {
    case 'mark-running':
      if (cur === 'pending') return 'running'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-done':
      if (cur === 'running') return 'done'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-failed':
      if (
        cur === 'pending' ||
        cur === 'running' ||
        cur === 'awaiting_review' ||
        cur === 'awaiting_human'
      ) {
        return 'failed'
      }
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-canceled':
      // Anything non-terminal can be canceled (user-initiated abort, shutdown).
      return 'canceled'
    case 'mark-interrupted':
      // Daemon restart reaping — any non-terminal row.
      return 'interrupted'
    case 'park-review':
      if (cur === 'pending' || cur === 'running') return 'awaiting_review'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'approve-review':
      if (cur === 'awaiting_review') return 'done'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'iterate-review':
    case 'reject-review':
      if (cur === 'awaiting_review') return 'pending'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'park-human':
      if (cur === 'pending' || cur === 'running') return 'awaiting_human'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'resume-clarify':
      // clarify node_run goes done when the user submits answers — the
      // SOURCE agent gets a fresh node_run separately (mint, not transition).
      if (cur === 'awaiting_human') return 'done'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'cancel-by-supersede':
      if (
        cur === 'pending' ||
        cur === 'running' ||
        cur === 'awaiting_review' ||
        cur === 'awaiting_human'
      ) {
        return 'canceled'
      }
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-skipped':
      if (cur === 'pending') return 'skipped'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-exhausted':
      if (cur === 'running') return 'exhausted'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    default: {
      // exhaustiveness — adding a new NodeRunTransitionEvent kind without handling it
      // here is a compile error.
      const _exhaustive: never = ev
      void _exhaustive
      throw new IllegalNodeRunTransition(
        cur,
        (ev as NodeRunTransitionEvent).kind,
        'unhandled event',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: the set of statuses from which an event is allowed.
// ---------------------------------------------------------------------------

/**
 * Returns the set of `from` statuses for which `nextNodeRunStatus(from, ev)`
 * does NOT throw. Useful for the lower-level `setNodeRunStatus()` helper and
 * for tests.
 */
export function allowedFromStatusesForEvent(ev: NodeRunTransitionEvent): readonly NodeRunStatus[] {
  const allowed: NodeRunStatus[] = []
  for (const s of NODE_RUN_STATUS) {
    if (isTerminalNodeRunStatus(s)) continue
    try {
      nextNodeRunStatus(s, ev)
      allowed.push(s)
    } catch {
      // not allowed from this status
    }
  }
  return allowed
}

// ===========================================================================
// RFC-108 T1/T2 (AR-12 / AR-19 / 01-LIFE-01) — task.status state machine.
//
// node_run has had `nextNodeRunStatus` (transition-table SSOT) since RFC-053,
// but task-level was CAS-only (RFC-097) with `allowedFrom` hand-copied at ~20
// call sites (01-LIFE-01/02 drift). This adds the SYMMETRIC oracle so any new
// recovery status write (auto-resume, etc.) routes through one table instead
// of a fresh hand-written `allowedFrom`. Per the Codex audit cross-check this
// lands as a NON-disruptive two-step: introduce the oracle + an event-path
// wrapper that NEW callers use; the existing call sites keep their explicit
// `allowedFrom` and migrate incrementally (no big-bang churn).
//
// New task status or event? The `switch` below fails compilation (`never`)
// until you fill it in.
// ===========================================================================

/** Terminal task statuses — once reached, only resume/retry may move out (and
 *  only via the `allowTerminal` escape hatch held by resume/retry/repair). */
export const TERMINAL_TASK_STATUSES = [
  'done',
  'failed',
  'canceled',
  'interrupted',
] as const satisfies readonly TaskStatus[]

export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(s)
}

/** Task-level transition events (business transitions). Mirrors the node_run
 *  ADT. Targets are fixed per event (independent of the source within the
 *  event's allowed-from set), so `targetForTaskEvent` is total. */
export type TaskTransitionEvent =
  | { kind: 'claim' } // pending → running (scheduler picks up)
  | { kind: 'complete' } // running → done
  | { kind: 'park-review' } // pending|running → awaiting_review
  | { kind: 'park-human' } // pending|running → awaiting_human
  | { kind: 'unpark' } // awaiting_* → running (gate answered, work continues)
  | { kind: 'fail'; reason?: string } // pending|running|awaiting_* → failed
  | { kind: 'cancel'; reason?: string } // pending|running|awaiting_* → canceled
  | { kind: 'interrupt' } // pending|running → interrupted (reaper / shutdown)
  | { kind: 'resume' } // failed|interrupted|awaiting_* → pending (resumeTask / auto-resume)
  | { kind: 'retry' } // done|failed|canceled|interrupted → pending (retryNode)
  | { kind: 'sync-workflow' } // RFC-109: any non-active → pending (syncTaskWorkflow); = resume ∪ retry

export class IllegalTaskTransition extends Error {
  readonly code = 'illegal-task-transition' as const
  constructor(
    readonly from: TaskStatus,
    readonly eventKind: TaskTransitionEvent['kind'],
    extra?: string,
  ) {
    super(
      `illegal task transition: from='${from}' via event='${eventKind}'${extra ? ` (${extra})` : ''}`,
    )
  }
}

/** The fixed target status an event drives toward (does not depend on source). */
export function targetForTaskEvent(ev: TaskTransitionEvent): TaskStatus {
  switch (ev.kind) {
    case 'claim':
    case 'unpark':
      return 'running'
    case 'complete':
      return 'done'
    case 'park-review':
      return 'awaiting_review'
    case 'park-human':
      return 'awaiting_human'
    case 'fail':
      return 'failed'
    case 'cancel':
      return 'canceled'
    case 'interrupt':
      return 'interrupted'
    case 'resume':
    case 'retry':
    case 'sync-workflow':
      return 'pending'
    default: {
      const _exhaustive: never = ev
      void _exhaustive
      throw new IllegalTaskTransition(
        'pending',
        (ev as TaskTransitionEvent).kind,
        'unhandled event',
      )
    }
  }
}

/**
 * Canonical (status, event) → status table for tasks — the single source of
 * truth for "is this task transition legal at all". Callers that need a
 * NARROWER allowed-from (e.g. scheduler cancel only from `running` because it
 * already holds the claim) may still pass an explicit subset; this oracle is
 * the superset. Throws IllegalTaskTransition for illegal pairs.
 */
export function nextTaskStatus(cur: TaskStatus, ev: TaskTransitionEvent): TaskStatus {
  const ok = (froms: readonly TaskStatus[]): TaskStatus => {
    if (froms.includes(cur)) return targetForTaskEvent(ev)
    throw new IllegalTaskTransition(cur, ev.kind)
  }
  switch (ev.kind) {
    case 'claim':
      return ok(['pending'])
    case 'complete':
      return ok(['running'])
    case 'park-review':
    case 'park-human':
      return ok(['pending', 'running'])
    case 'unpark':
      return ok(['awaiting_review', 'awaiting_human'])
    case 'fail':
      return ok(['pending', 'running', 'awaiting_review', 'awaiting_human'])
    case 'cancel':
      return ok(['pending', 'running', 'awaiting_review', 'awaiting_human'])
    case 'interrupt':
      return ok(['pending', 'running'])
    case 'resume':
      // resume reanimates a parked or terminal-but-recoverable task.
      return ok(['failed', 'interrupted', 'awaiting_review', 'awaiting_human'])
    case 'retry':
      // single-node retry can re-open any terminal task.
      return ok(['done', 'failed', 'canceled', 'interrupted'])
    case 'sync-workflow':
      // RFC-109: re-point a non-active task at the latest workflow definition
      // and continue. Spans every non-active status = resume ∪ retry.
      return ok(['failed', 'interrupted', 'done', 'canceled', 'awaiting_review', 'awaiting_human'])
    default: {
      const _exhaustive: never = ev
      void _exhaustive
      throw new IllegalTaskTransition(cur, (ev as TaskTransitionEvent).kind, 'unhandled event')
    }
  }
}

/** The set of `from` statuses for which `nextTaskStatus(from, ev)` is legal. */
export function allowedFromForTaskEvent(ev: TaskTransitionEvent): readonly TaskStatus[] {
  const allowed: TaskStatus[] = []
  for (const s of TASK_STATUS) {
    try {
      nextTaskStatus(s, ev)
      allowed.push(s)
    } catch {
      // not allowed from this status
    }
  }
  return allowed
}
