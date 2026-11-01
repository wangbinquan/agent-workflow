import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'

// RFC-404 — the error decisions of the call node (call-workflow / call-workgroup). The engine body may
// not import `@/util/errors`; keeping them here leaves the decisions with task-execution instead of
// moving them into the composition bindings.

/** A failed child launch settles with the domain error's own code; anything else is a generic launch failure. */
export function childLaunchFailureCode(error: unknown): string {
  return error instanceof ValidationError ||
    error instanceof DomainError ||
    error instanceof NotFoundError
    ? error.code
    : 'child-launch-failed'
}

/**
 * Cascading a user cancel into the child tolerates the child being already terminal
 * (`task-not-cancelable`) or gone. Anything else — a missing or broken topology adapter
 * included — is not cancellation success and must propagate.
 */
export function isToleratedChildCancelRace(error: unknown): boolean {
  return (
    (error instanceof ConflictError && error.code === 'task-not-cancelable') ||
    error instanceof NotFoundError
  )
}

/** Refusals raised while assembling a child launch; the launch catch turns them into the row's failure code. */
export function childCallRefusal(
  code: 'call-owner-inactive' | 'trigger-context-missing' | 'workflow-invalid',
  message: string,
): Error {
  return new ValidationError(code, message)
}
