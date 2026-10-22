// RFC-395 II-pre：测试复用生产工作区维护装配，保留每个实例的 in-flight 状态。
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import { createNodeWorkspaceMaintenanceFilesystem } from '@/modules/source-control/infrastructure/nodeWorkspaceMaintenanceFilesystem'
import { DrizzleTerminalMaintenancePersistence } from '@/modules/task-execution/infrastructure/terminalMaintenancePersistence'
import { materializingSpaces } from '@/platform/workspace/materializingSpaces'
import { Paths } from '@/util/paths'

const instances = new WeakMap<
  PersistenceDb,
  Map<string, ReturnType<typeof composeWorkspaceMaintenanceCommand>>
>()

export function workspaceMaintenanceForTest(db: PersistenceDb, appHome = Paths.root) {
  let byHome = instances.get(db)
  if (byHome === undefined) {
    byHome = new Map()
    instances.set(db, byHome)
  }
  let command = byHome.get(appHome)
  if (command === undefined) {
    command = composeWorkspaceMaintenanceCommand({
      db,
      appHome,
      terminalMaintenance: new DrizzleTerminalMaintenancePersistence(db),
      isMaterializingTask: (taskId) => materializingSpaces.has(taskId),
      invalidateWorkspacePath: () => {},
    })
    byHome.set(appHome, command)
  }
  return command
}

export function workspaceMaintenanceFilesystemForTest(appHome: string) {
  return createNodeWorkspaceMaintenanceFilesystem({
    appHome,
    isMaterializingTask: (taskId) => materializingSpaces.has(taskId),
    invalidateWorkspacePath: () => {},
  })
}
