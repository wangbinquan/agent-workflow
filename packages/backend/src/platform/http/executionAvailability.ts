// RFC-370 v2 H7 — request-level execution gating.
//
// Routes declare an `executionGroup` when they start execution. The
// composition root binds the instance's status reader to its app; a grouped
// request on an instance that is not active fails fast with 503 while every
// resource route keeps working. Bound operation invocations (MCP) enter the
// same registered handler chain without Hono middleware, so the reader is
// keyed by the app instance like the bound handler table itself.

import {
  isExecutionAvailable,
  type ExecutionGroup,
  type ExecutionStatus,
} from '@agent-workflow/shared'
import { DomainError } from '@/util/errors'

// RFC-536: the reader rides on the app it serves (a non-enumerable, read-only own symbol property) — there is no
// process-level table from apps to readers.
const EXECUTION_STATUS_READER = Symbol('execution-status-reader')

function readerOf(app: object): (() => ExecutionStatus) | undefined {
  return Object.hasOwn(app, EXECUTION_STATUS_READER)
    ? (app as { readonly [EXECUTION_STATUS_READER]: () => ExecutionStatus })[
        EXECUTION_STATUS_READER
      ]
    : undefined
}

export function attachExecutionAvailability(app: object, read: () => ExecutionStatus): void {
  if (readerOf(app) !== undefined) throw new Error('execution-availability-already-bound')
  Object.defineProperty(app, EXECUTION_STATUS_READER, { value: read })
}

/**
 * The bound status. Production binds the reader in `mountApiRoutes` before any route mounts; RFC-426: an unbound app has
 * no status to report (the deployment kind comes from the profile, never from a fallback here).
 */
export function readExecutionStatus(app: object): ExecutionStatus {
  const read = readerOf(app)
  if (read === undefined) throw new Error('execution-availability-unbound')
  return read()
}

export function assertExecutionAvailable(app: object, group: ExecutionGroup | undefined): void {
  if (group === undefined) return
  const read = readerOf(app)
  // RFC-426: a test or tool root without a bound reader has no execution gate (as before, without inventing a status).
  if (read === undefined) return
  const status = read()
  if (status.unavailableGroups?.[group] !== undefined) {
    throw new DomainError('hosted-capability-unavailable', status.unavailableGroups[group], 503, {
      group,
    })
  }
  if (isExecutionAvailable(status, group)) return
  throw new DomainError('execution-standby', 'This instance is not executing work right now', 503, {
    group,
    mode: status.mode,
    state: status.state,
    reason: status.reason,
  })
}
