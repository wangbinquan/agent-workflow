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

const readers = new WeakMap<object, () => ExecutionStatus>()

export function bindExecutionAvailability(app: object, read: () => ExecutionStatus): void {
  if (readers.has(app)) throw new Error('execution-availability-already-bound')
  readers.set(app, read)
}

/** An app without a bound reader is a standalone test or tool root: always available. */
export function readExecutionStatus(app: object): ExecutionStatus {
  return readers.get(app)?.() ?? { mode: 'standalone', state: 'active', reason: null }
}

export function assertExecutionAvailable(app: object, group: ExecutionGroup | undefined): void {
  if (group === undefined) return
  const status = readExecutionStatus(app)
  if (isExecutionAvailable(status)) return
  throw new DomainError('execution-standby', 'This instance is not executing work right now', 503, {
    group,
    mode: status.mode,
    state: status.state,
    reason: status.reason,
  })
}
