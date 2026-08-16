// RFC-304 §11.2 (T59) — who asked, and therefore who is owed an answer.
//
// The first draft made every capability silent on the merge request, on the
// reasoning that a bot which announces its own failures is a bot people mute.
// That is right for the automatic paths and wrong for the manual ones, and the
// second design gate caught it:
//
//   a reviewer @-mentions the platform to fix a comment, or an author types the
//   confirmation keyword, and half an hour later nothing has happened. They
//   cannot tell whether it was never received, is queued behind a lease, or
//   failed — so they @-mention it AGAIN, producing another round and more
//   noise. Silence does not reduce noise here; it multiplies it.
//
// So visibility is decided by SOURCE, not by outcome:
//
//   automatic (MR events, pipeline events) — stay silent, alert inside the
//     platform. Nobody is waiting on a specific reply, and a failure comment
//     per red pipeline is exactly what gets a bot muted.
//   manual (@-mention, confirmation keyword, issue label, /code or API) —
//     always answer, on ONE updatable receipt. The person is holding the other
//     end of the conversation.
//
// ## Why a receipt rather than a comment per event
//
// "Received → running → done" as three comments is three notifications for one
// question. The receipt is created when the instruction arrives and EDITED in
// place, so the whole exchange costs one notification and reads top-to-bottom.

/** How a round came to exist. */
export type TriggerSource =
  /** A merge-request or pipeline event nobody typed. */
  | 'webhook'
  /** Someone @-mentioned the platform in a comment. */
  | 'mention'
  /** An author typed a confirmation keyword on a posted patch. */
  | 'confirmation'
  /** A label was applied to an issue. */
  | 'issue-label'
  /** Started from the `/code` page or the platform API. */
  | 'platform'

export const TRIGGER_SOURCES: readonly TriggerSource[] = [
  'webhook',
  'mention',
  'confirmation',
  'issue-label',
  'platform',
]

/**
 * Whether a person is waiting for an answer to THIS trigger.
 *
 * The distinction is "did a human address the platform", not "did a human cause
 * it". Pushing a commit is a human action and produces a webhook, but nobody
 * asked the platform anything — announcing a failure there is the noise this
 * whole section exists to avoid.
 */
export function isManualInstruction(source: TriggerSource): boolean {
  return source !== 'webhook'
}

/**
 * Which source an incoming webhook event represents.
 *
 * The mapping is the whole of §11.2 in one place: everything a person TYPED at
 * the platform gets an answer, everything the code host emitted on its own does
 * not. Getting it wrong in one direction produces a bot that comments on every
 * red pipeline; in the other, a reviewer who @-mentions the platform and hears
 * nothing, then @-mentions it again.
 *
 * Unknown event types are `webhook` — the quiet default. A new event type that
 * turns out to be a manual instruction is a missing line here, and the symptom
 * is silence rather than a merge request full of machine comments.
 */
export function triggerSourceOfEvent(eventType: string): TriggerSource {
  // A comment is the one event a person definitely typed. Whether it was an
  // @-mention or the confirmation keyword is decided further in, by whoever
  // reads the body; both are manual, which is all this decides. `note` is the
  // platform's own name for a merge-request comment on BOTH hosts
  // (gitlabAdapter / githubAdapter both normalise to it), and `issue_comment`
  // is the same event on an issue.
  if (eventType === 'note' || eventType === 'issue_comment') return 'mention'
  if (eventType === 'issue_labeled') return 'issue-label'
  return 'webhook'
}

export type FailureVisibility =
  /** Post nothing on the merge request; raise it inside the platform. */
  | { kind: 'platform-only'; reason: string }
  /** Update the receipt this instruction already owns. */
  | { kind: 'receipt'; operationId: string }

/**
 * Where a failure is reported.
 *
 * `operationId` is required for the manual path and that is deliberate: a
 * receipt with no id cannot be found again, so the "update in place" promise
 * silently degrades into appending a new comment per attempt — which is the
 * behaviour this replaces.
 */
export function failureVisibilityOf(input: {
  source: TriggerSource
  operationId: string | null
}): FailureVisibility {
  if (!isManualInstruction(input.source)) {
    return {
      kind: 'platform-only',
      reason: 'an automatic trigger has nobody waiting on a reply; a comment per failure is noise',
    }
  }
  if (input.operationId === null) {
    // A manual instruction that lost its receipt id. Reported inside the
    // platform rather than posted as a fresh comment: appending is precisely
    // what the receipt exists to prevent, and a duplicate under a lost id is
    // indistinguishable to the reader from the platform having answered twice.
    return {
      kind: 'platform-only',
      reason: 'this manual instruction has no receipt to update, so a new comment would duplicate',
    }
  }
  return { kind: 'receipt', operationId: input.operationId }
}

const RECEIPT_MARKER_PREFIX = '<!-- aw-receipt:'

/** The hidden marker that lets a later round find this receipt again. */
export function receiptMarker(operationId: string): string {
  return `${RECEIPT_MARKER_PREFIX}${operationId} -->`
}

export function readReceiptMarker(body: string): string | null {
  const match = /<!-- aw-receipt:([A-Za-z0-9_-]+) -->/.exec(body)
  return match?.[1] ?? null
}

export type ReceiptState =
  | { kind: 'received' }
  | { kind: 'running'; detail?: string }
  | { kind: 'done'; detail: string }
  | { kind: 'failed'; detail: string }
  /** Waiting on a person — not a failure, and must not read like one. */
  | { kind: 'awaiting'; detail: string }

/**
 * The receipt body for one state.
 *
 * Always carries the marker, always the whole message — this REPLACES the
 * previous body rather than appending to it, so a reader sees the current state
 * and not a transcript of every state it passed through.
 */
export function renderReceipt(operationId: string, state: ReceiptState): string {
  const line = ((): string => {
    switch (state.kind) {
      case 'received':
        return 'Got it — queued.'
      case 'running':
        return state.detail === undefined ? 'Working on it.' : `Working on it: ${state.detail}`
      case 'done':
        return state.detail
      case 'failed':
        // Named as a failure of the attempt, not of the person's request. A
        // reader who cannot tell which will re-send the same instruction.
        return `That did not work: ${state.detail}`
      case 'awaiting':
        return state.detail
    }
  })()

  return `${receiptMarker(operationId)}\n${line}`
}
