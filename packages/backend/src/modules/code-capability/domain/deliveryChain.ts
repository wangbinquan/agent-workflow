// RFC-304 §11.3 (T61) — where a delivery stopped, as a fact rather than a guess.
//
// The situation this exists for: an administrator says "review stopped working
// on this repository". The three things they can check today all fail to answer:
//
//   `readiness = ready`   — says the CONFIG is complete, not that anything ran.
//   last trigger time     — says nothing arrived, but not whether the webhook
//                           was never sent, was sent and dropped by routing, or
//                           arrived and is queued behind a lease.
//   "send a test event"   — if it takes a shortcut past the real path, a green
//                           test proves only that the shortcut works.
//
// Each of those is a different fix — reconfigure the hook, correct the routing,
// wait or raise a quota — and without the chain the administrator is guessing
// between them.
//
// So every delivery records the step it reached. The value of the record is
// almost entirely in the FAILURE steps carrying a reason: "dropped" alone moves
// the question rather than answering it.

/**
 * The steps a delivery passes through, in order.
 *
 * Ordered because "where did it stop" is only meaningful against a known
 * sequence — the reader's next question is always "and what comes after that".
 */
export const DELIVERY_STEPS = [
  /** The daemon received an ingress request and authenticated it. */
  'received',
  /** It matched a configured capability cell. */
  'matched',
  /** Routing chose a capability, or deliberately chose none. */
  'routed',
  /** Waiting on the merge-request lease or a global concurrency quota. */
  'queued',
  /** A round was opened and its task started. */
  'round',
  /** The round finished and its result reached the code host. */
  'published',
] as const
export type DeliveryStep = (typeof DELIVERY_STEPS)[number]

export type DeliveryOutcome =
  /** Still moving, or finished successfully at `step`. */
  | { kind: 'ok'; step: DeliveryStep }
  /**
   * Stopped on purpose. NOT a failure — a healthy platform drops most
   * deliveries, and colouring them red trains an administrator to ignore the
   * colour that means something is broken.
   */
  | { kind: 'dropped'; step: DeliveryStep; reason: string }
  /** Stopped because something went wrong. */
  | { kind: 'failed'; step: DeliveryStep; reason: string }

export function stepIndex(step: DeliveryStep): number {
  return DELIVERY_STEPS.indexOf(step)
}

/**
 * The sentence an administrator reads.
 *
 * Always names the step AND what comes next, because "stopped at queued" leaves
 * the reader asking "queued behind what, and for how long" — which is the
 * question they actually came with.
 */
export function describeDelivery(outcome: DeliveryOutcome): string {
  const next = DELIVERY_STEPS[stepIndex(outcome.step) + 1]
  switch (outcome.kind) {
    case 'ok':
      return next === undefined
        ? 'Delivered: the result reached the code host.'
        : `Reached “${outcome.step}”; waiting on “${next}”.`
    case 'dropped':
      // Phrased as a decision, not a fault. Most deliveries are dropped and
      // that is the system working.
      return `Stopped at “${outcome.step}” on purpose: ${outcome.reason}`
    case 'failed':
      return `Failed at “${outcome.step}”: ${outcome.reason}`
  }
}

/** Whether this outcome needs an administrator to do something. */
export function needsAttention(outcome: DeliveryOutcome): boolean {
  return outcome.kind === 'failed'
}

export interface QueueDetail {
  /** How long it has been waiting, in ms. */
  ageMs: number
  /** Position in the queue, 1-based; null when the queue is not ordered. */
  position: number | null
  /** What it waits on — a merge-request lease or a global quota. */
  waitingOn: 'mr-lease' | 'global-quota'
}

/**
 * A queued delivery's line, including age and position.
 *
 * Both numbers are the point. "Queued" alone is indistinguishable from "stuck",
 * and an administrator who cannot tell them apart will restart the daemon —
 * which discards the queue and turns a wait into a loss.
 */
export function describeQueue(detail: QueueDetail): string {
  const minutes = Math.floor(detail.ageMs / 60_000)
  const age =
    minutes < 1 ? 'less than a minute' : `${String(minutes)} minute${minutes === 1 ? '' : 's'}`
  const what =
    detail.waitingOn === 'mr-lease'
      ? 'another round holds this merge request'
      : 'the global concurrency limit is reached'
  const where = detail.position === null ? '' : ` (position ${String(detail.position)})`
  return `Waiting ${age}${where}: ${what}.`
}
