import type { ExecutionStatus } from '@agent-workflow/shared'
import type { ExecutionAuthorityPort } from './ports/executionAuthority'

/**
 * The public projection of an authority, shared by HTTP gating and the status route. RFC-425: the deployment kind
 * comes from the deployment profile; the authority only answers whether this instance may execute.
 */
export function executionStatusOf(
  authority: ExecutionAuthorityPort,
  mode: ExecutionStatus['mode'],
): ExecutionStatus {
  const state = authority.current()
  return {
    mode,
    state: state.kind,
    reason: state.kind === 'active' ? null : state.reason,
    ...(authority.unavailableGroups === undefined
      ? {}
      : { unavailableGroups: authority.unavailableGroups }),
  }
}
