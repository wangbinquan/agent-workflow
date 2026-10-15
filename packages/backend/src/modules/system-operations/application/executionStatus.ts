import type { ExecutionStatus } from '@agent-workflow/shared'
import type { ExecutionAuthorityPort } from './ports/executionAuthority'

/** The public projection of an authority, shared by HTTP gating and the status route. */
export function executionStatusOf(authority: ExecutionAuthorityPort): ExecutionStatus {
  const state = authority.current()
  return {
    mode: authority.mode,
    state: state.kind,
    reason: state.kind === 'active' ? null : state.reason,
    ...(authority.unavailableGroups === undefined
      ? {}
      : { unavailableGroups: authority.unavailableGroups }),
  }
}
