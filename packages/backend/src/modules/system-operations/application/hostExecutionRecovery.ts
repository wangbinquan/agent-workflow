import type { HostExecutionAuthorityLifecycle } from './ports/hostExecutionAuthority'
import type { HostExecutionRecoveryCommands } from '../public/commands'

/** The original authority queue owns retirement and the next grant. This
 * command does not kill business executions or acknowledge their outcomes. */
export function createHostExecutionRecoveryCommands(input: {
  readonly mode: 'execution' | 'resource-only'
  readonly lifecycle: HostExecutionAuthorityLifecycle
}): HostExecutionRecoveryCommands {
  const start = input.lifecycle.start.bind(input.lifecycle),
    mode = input.mode
  return Object.freeze({
    async retryActivation() {
      if (mode !== 'execution') throw new Error('host-execution-recovery-not-selected')
      await start()
    },
  })
}
