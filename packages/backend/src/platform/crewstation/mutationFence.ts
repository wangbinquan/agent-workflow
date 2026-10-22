import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { BusinessExecutionFence } from './businessExecution'

/** The composition root supplies the application lease. Network adapters
 * obtain a current fence for each mutation; durable intent writes check that
 * same fence while holding the application's control row in their transaction. */
export interface CrewStationMutationFence {
  current(): BusinessExecutionFence
  assertHeld(tx: PersistenceDb, fence: BusinessExecutionFence): Promise<void>
}
