import type { WorkgroupTaskRoomCommands } from '../../public/commands'
import type { WorkgroupTaskRoomModule } from '../../public/operations'
import type { WorkgroupTaskRoomQueries } from '../../public/queries'

/**
 * Provider-facing application driver.  It is deliberately identical to the
 * closed public use cases: composition may bind SQLite or PostgreSQL without
 * allowing a client, transaction, Actor, or persistence row through the route.
 */
export interface WorkgroupTaskRoomDriver {
  readonly commands: WorkgroupTaskRoomCommands
  readonly queries: WorkgroupTaskRoomQueries
}

export function createWorkgroupTaskRoomApplication(
  driver: WorkgroupTaskRoomDriver,
): WorkgroupTaskRoomModule {
  return Object.freeze({
    commands: Object.freeze({
      postMessage: driver.commands.postMessage.bind(driver.commands),
      deliverAssignment: driver.commands.deliverAssignment.bind(driver.commands),
      confirmGate: driver.commands.confirmGate.bind(driver.commands),
      confirmDynamicWorkflow: driver.commands.confirmDynamicWorkflow.bind(driver.commands),
      saveDynamicWorkflow: driver.commands.saveDynamicWorkflow.bind(driver.commands),
      updateConfig: driver.commands.updateConfig.bind(driver.commands),
      cancelAssignment: driver.commands.cancelAssignment.bind(driver.commands),
    }),
    queries: Object.freeze({
      pendingCount: driver.queries.pendingCount.bind(driver.queries),
      pending: driver.queries.pending.bind(driver.queries),
      room: driver.queries.room.bind(driver.queries),
    }),
  })
}
