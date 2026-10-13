import { createIntentTurnExecutionLifecycle } from '../application/executionLifecycle'
import { recoverOwnedIntentTurn, type IntentDispatchDeps } from '../application/dispatcher'
import type { IntentTurnExecutionLifecycle } from '../application/ports/intentExecution'

export { IntentOriginalExecutionPendingError } from '../application/executionLifecycle'
export type { IntentTurnExecutionLifecycle } from '../application/ports/intentExecution'

export function composeIntentTurnExecution(): IntentTurnExecutionLifecycle {
  return createIntentTurnExecutionLifecycle()
}

/** The root captures one real Intent provider/family for cold reconciliation. */
export function configureIntentTurnExecutionRecovery(
  execution: IntentTurnExecutionLifecycle,
  deps: Omit<IntentDispatchDeps, 'configSnapshot'>,
): void {
  const load = deps.persistence.listExecutionCheckpoints.bind(deps.persistence)
  execution.configureRecovery({
    load,
    recover: (checkpoint, control) => recoverOwnedIntentTurn(deps, checkpoint, control),
  })
}
