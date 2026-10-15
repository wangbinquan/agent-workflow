// RFC-370 M0 — a CrewStation-hosted control plane without remote execution yet.
// The instance serves resources and Settings but never becomes active, so
// every execution entry reports `standby` with the reason and no execution
// background task starts. M1 replaces this with the platform's fenced
// execution lease.
import type {
  ExecutionAuthorityPort,
  ExecutionAuthorityState,
  ExecutionFence,
} from '../../application/ports/executionAuthority'

export function createStandbyExecutionAuthority(input: {
  readonly reason: string
}): ExecutionAuthorityPort {
  const state: ExecutionAuthorityState = Object.freeze({ kind: 'standby', reason: input.reason })
  const never = new Promise<ExecutionFence>(() => {})
  return Object.freeze({
    mode: 'crewstation',
    current: () => state,
    whenActive: () => never,
    onLost: () => () => {},
    close: async () => {},
  })
}
