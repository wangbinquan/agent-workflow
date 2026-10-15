import type { ProviderNeutralDatabase } from '@/db/query'
import type { BusinessExecutionFence } from './businessExecution'

/** The composition root supplies the application lease. Network adapters
 * obtain a current fence for each mutation; durable intent writes check that
 * same fence while holding the application's control row in their transaction. */
export interface CrewStationMutationFence {
  current(): BusinessExecutionFence
  assertHeld(tx: ProviderNeutralDatabase, fence: BusinessExecutionFence): Promise<void>
}
