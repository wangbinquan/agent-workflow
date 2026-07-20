// RFC-208 — classify how a failed request leaves the SERVER, not how it looked
// to the client.
//
// The distinction that matters is not the HTTP status but whether replaying the
// call is harmless. A transport failure tells you the response never came back;
// it does NOT tell you the request never arrived. Timeouts and aborts routinely
// fire after the server has already committed, and the browser cannot
// distinguish "never connected" from "sent, answer lost".
//
// So: only a 4xx proves the server rejected the work, and only an idempotent
// call is safe to replay after transport loss. Everything else is genuinely
// unknown and must be reconciled rather than assumed.

import { ApiError } from '@/api/client'

export type WriteOutcome =
  /** The server explicitly rejected it; client state is trustworthy. */
  | 'definitive'
  /** Replay is harmless — safe to just try again. */
  | 'retriable'
  /** The server may or may not have applied it; reconcile before trusting anything. */
  | 'unknown'

export interface WriteOutcomeContext {
  /**
   * True only when replaying this exact call cannot cause a second effect —
   * a GET, or a write the server deduplicates by an idempotency key.
   *
   * An optimistic-concurrency fence (revision token) does NOT make a write
   * idempotent: it makes a stale replay *detectable* (409), which is a
   * different and weaker guarantee.
   */
  idempotent: boolean
}

/** True for failures where the request may never have reached the server. */
function isTransportFailure(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 0
  // A bare abort never produced a response either.
  return (
    error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}

export function classifyWriteOutcome(error: unknown, ctx: WriteOutcomeContext): WriteOutcome {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return 'definitive'
  if (isTransportFailure(error)) return ctx.idempotent ? 'retriable' : 'unknown'
  // 5xx and anything unrecognised: the handler was reached, so it may have
  // committed before failing. Never optimistic here.
  return 'unknown'
}
