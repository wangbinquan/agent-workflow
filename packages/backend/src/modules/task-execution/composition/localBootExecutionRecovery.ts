import type { BootExecutionRecoveryFactory } from '../application/ports/bootExecutionRecovery'
import { createLocalBootExecutionRecoveryFactory } from '../infrastructure/local/bootExecutionRecovery'

export { createLocalBootExecutionRecoveryFactory }

/** Only explicit native roots select the local default. */
export function selectLocalBootExecutionRecoveryFactory(
  selected: BootExecutionRecoveryFactory | undefined,
): BootExecutionRecoveryFactory {
  return selected === undefined ? createLocalBootExecutionRecoveryFactory() : selected
}
