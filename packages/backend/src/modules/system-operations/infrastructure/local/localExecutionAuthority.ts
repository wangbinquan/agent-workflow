import type {
  ExecutionAuthorityPort,
  ExecutionAuthorityState,
  ExecutionFence,
} from '../../application/ports/executionAuthority'

/** A standalone daemon owns its execution from start to exit. */
export function createLocalExecutionAuthority(): ExecutionAuthorityPort {
  const fence: ExecutionFence = Object.freeze({ epoch: 1, token: 'standalone' })
  const state: ExecutionAuthorityState = Object.freeze({ kind: 'active', fence })
  const active = Promise.resolve(fence)
  return Object.freeze({
    mode: 'standalone',
    current: () => state,
    whenActive: () => active,
    onLost: () => () => {},
    close: async () => {},
  })
}
