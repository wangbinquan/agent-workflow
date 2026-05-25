// Unified API error response per design.md §4.2.1:
//   { ok: false, code, message, details? }
//
// Throw a DomainError subclass from anywhere; the Hono error middleware below
// translates it into the right HTTP status + JSON body. Anything else becomes
// a 500 with code='internal-error' and gets logged.

import type { ErrorHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { createLogger } from './log'

const log = createLogger('errors')

export interface ErrorPayload {
  ok: false
  code: string
  message: string
  details?: unknown
}

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: ContentfulStatusCode = 400,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'DomainError'
  }

  toPayload(): ErrorPayload {
    const out: ErrorPayload = { ok: false, code: this.code, message: this.message }
    if (this.details !== undefined) out.details = this.details
    return out
  }
}

export class NotFoundError extends DomainError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, 404, details)
    this.name = 'NotFoundError'
  }
}

export class ValidationError extends DomainError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, 422, details)
    this.name = 'ValidationError'
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, 409, details)
    this.name = 'ConflictError'
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'missing or invalid token', details?: unknown) {
    super('unauthorized', message, 401, details)
    this.name = 'UnauthorizedError'
  }
}

/**
 * RFC-036 — raised by requirePermission / canViewTask when the resolved actor
 * lacks the required permission point. `code` differentiates the specific
 * failure (e.g. 'forbidden' / 'task-not-visible' / 'not-reviewer'); `details`
 * may carry `{ requiredPermission, actorPermissions[] }` for admin debugging.
 */
export class ForbiddenError extends DomainError {
  constructor(code: string = 'forbidden', message: string = 'forbidden', details?: unknown) {
    super(code, message, 403, details)
    this.name = 'ForbiddenError'
  }
}

/** Hono error handler. Mounted via `app.onError(errorHandler)`. */
export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof DomainError) {
    return c.json(err.toPayload(), err.status)
  }
  // RFC-053 PR-B — IllegalNodeRunTransition (defined in shared/lifecycle.ts
  // as plain `extends Error` to keep the shared layer free of backend
  // dependencies). At the HTTP boundary it is a 422 (caller asked for a
  // transition that the state machine doesn't allow), structurally
  // identical to ValidationError on the wire.
  if (isIllegalNodeRunTransition(err)) {
    return c.json<ErrorPayload>({ ok: false, code: err.code, message: err.message }, 422)
  }
  // log-only: HTTP boundary surfaces the failure as a 500 response to
  // the caller (the alert channel). Server-side log captures stack +
  // class for operator diagnosis; it doesn't and shouldn't synthesize
  // a lifecycle_alerts row for every random request error.
  log.error('unhandled error', {
    name: err.name,
    message: err.message,
    stack: err.stack,
  })
  return c.json<ErrorPayload>(
    { ok: false, code: 'internal-error', message: 'internal server error' },
    500,
  )
}

function isIllegalNodeRunTransition(
  err: unknown,
): err is { code: 'illegal-node-run-transition'; message: string } {
  return err instanceof Error && (err as { code?: unknown }).code === 'illegal-node-run-transition'
}
