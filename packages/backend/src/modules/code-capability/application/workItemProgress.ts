// RFC-304 §2.2 — driving the work-item state machine from real round outcomes.
//
// The transition table (`decideCodeWorkItemTransition`) and its CAS writer
// (`applyWorkItemEvent`) were built in PR-1a and had only test callers. Design
// D2 chose that machine deliberately — a SECOND lifecycle beside the task's,
// because a work item spans many tasks and the waiting-for-a-human state lives
// on the item rather than on a task suspended for three days — and §2.1–2.2
// calls it 整个系统的骨架. It was the skeleton nothing hung on.
//
// Meanwhile production improvised: `ensureWorkItem` wrote `idle`, `closeWorkItem`
// wrote `closed`, and nothing in between ever moved. So `/code` showed every
// item as idle while its rounds ran, and `awaiting` — the state the whole
// human-confirmation design turns on — was never reached.
//
// ## Why a wrapper, and why it never throws
//
// The status machine is BOOKKEEPING over a pipeline that already works. A round
// that published its review must not be failed because its work item happened
// to be in a state the table rejects — that would trade a real, delivered
// outcome for a bookkeeping disagreement, which is strictly worse than a wrong
// status column.
//
// So every non-applied outcome is logged and swallowed:
//
//   rejected — the event does not apply to the current status. Usually means an
//              earlier event was missed; the next `external-signal` re-queues
//              the item, so the machine self-heals rather than wedging.
//   raced    — another writer moved the row between read and write. The other
//              writer's transition is equally valid; re-applying blindly could
//              double-count an epoch bump.
//   missing  — no work item, which is the ordinary case for a capability that
//              runs without one (a direct round on an unregistered anchor).
//
// What this does NOT do is invent effects. `start-round`, `request-round-cancel`
// and `post-handoff-summary` are the caller's to perform; this only advances
// the row and reports what the table decided.

import {
  applyWorkItemEvent,
  type ApplyOutcome,
} from '@/modules/code-capability/infrastructure/sqliteWorkItemStore'
import type { CodeWorkItemEvent } from '@/modules/code-capability/domain/workItemLifecycle'
import type { DbClient } from '@/db/client'
import { createLogger } from '@/util/log'

const log = createLogger('code-work-item')

export interface NoteWorkItemEventArgs {
  db: DbClient
  /** Null when this round has no work item — then nothing is recorded. */
  workItemId: string | null | undefined
  event: CodeWorkItemEvent
  /** Whether a round's task is still live; the table's guards read it. */
  hasLiveRound: boolean
  resumeFromStage?: string | null
}

/**
 * Advance the work item, and never let bookkeeping break a round.
 *
 * Returns the outcome so a caller that DOES care (a test, or a future caller
 * that must run an effect) can inspect it, while the common caller can ignore it.
 */
export async function noteWorkItemEvent(args: NoteWorkItemEventArgs): Promise<ApplyOutcome> {
  if (args.workItemId === null || args.workItemId === undefined || args.workItemId === '') {
    return { outcome: 'missing' }
  }

  try {
    const outcome = await applyWorkItemEvent({
      db: args.db,
      workItemId: args.workItemId,
      event: args.event,
      hasLiveRound: args.hasLiveRound,
      ...(args.resumeFromStage === undefined ? {} : { resumeFromStage: args.resumeFromStage }),
    })

    if (outcome.outcome === 'rejected') {
      // Logged at WARN, not silently: a rejection means the machine and the
      // pipeline disagree about where this item is, and a run of them is the
      // signal that an emission point is missing.
      log.warn('transition rejected', {
        workItemId: args.workItemId,
        event: args.event.kind,
        reason: outcome.reason,
      })
    } else if (outcome.outcome === 'raced') {
      log.info('transition raced', {
        workItemId: args.workItemId,
        event: args.event.kind,
        expected: outcome.expected,
      })
    }
    return outcome
  } catch (error) {
    // A throw here would take down a round that may already have posted its
    // review. The status column is not worth that.
    log.warn('transition failed', {
      workItemId: args.workItemId,
      event: args.event.kind,
      error: error instanceof Error ? error.message : String(error),
    })
    return { outcome: 'missing' }
  }
}
