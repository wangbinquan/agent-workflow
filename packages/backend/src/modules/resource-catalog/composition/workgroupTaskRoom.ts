import { createWorkgroupTaskRoomApplication } from '../application/workgroups/workgroupTaskRoom'
import {
  createWorkgroupTaskRoomTransactionRunner,
  type WorkgroupTaskRoomDependencies,
} from '../infrastructure/workgroupTaskRoom'
import { createWorkgroupTaskRoomCommands } from '../infrastructure/workgroupTaskRoomCommands'
import { createWorkgroupTaskRoomQueries } from '../infrastructure/workgroupTaskRoomQueries'
import type { WorkgroupTaskRoomModule } from '../application/workgroups/taskRoomContracts'

// RFC-504: the room's active-user directory and dynamic-workflow revalidation / save-as are application use cases
// (application/workgroups/taskRoomCollaborators.ts); bootstrap takes them here together with the room assembly.
export {
  createWorkgroupTaskRoomActiveUsers,
  createWorkgroupTaskRoomDynamicWorkflow,
} from '../application/workgroups/taskRoomCollaborators'

/**
 * RFC-359 W4-D19b —— 工作组任务房一份装配（此前 SQLite 走 legacy engine 上的薄驱动、PG 走原生实现）。
 * 一笔事务同时交给 Resource Catalog 与 TaskExecution 两半参与者；两个 provider 走同一条路。
 */
export function composeWorkgroupTaskRoom(
  dependencies: WorkgroupTaskRoomDependencies,
): WorkgroupTaskRoomModule {
  const transaction = createWorkgroupTaskRoomTransactionRunner(dependencies)
  return createWorkgroupTaskRoomApplication({
    commands: createWorkgroupTaskRoomCommands(dependencies, transaction),
    queries: createWorkgroupTaskRoomQueries(transaction),
  })
}
