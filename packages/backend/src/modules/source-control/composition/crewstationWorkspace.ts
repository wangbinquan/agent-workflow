import type { SecretBox } from '@/auth/secretBox'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { materializingSpaces } from '@/services/gc'
import type { MaterializedSpace } from '../application/workspaceMaterialization'
import { createHostedTaskWorkspaces } from '../infrastructure/crewstation/taskWorkspace'
import { createHostedWorkspaceEffects } from '../infrastructure/crewstation/workspaceEffects'
import { createHostedWorkspaceMaintenance } from '../infrastructure/crewstation/workspaceMaintenance'
import { createHostedIsolationWorkspaces } from '../infrastructure/crewstation/isolationWorkspace'
import {
  createHostedRepositoryPreparation,
  createHostedScratchWorkspaces,
} from '../infrastructure/crewstation/repositoryPreparation'
import {
  hostedWorkspaceReference,
  parseHostedWorkspaceReference,
  joinHostedWorkspaceReference,
} from '../infrastructure/crewstation/workspaceReference'

/** Source Control owns both parent volumes and all interpretations of their references. */
export function composeCrewStationWorkspaceOwner(
  input: Parameters<typeof createHostedTaskWorkspaces>[0] & { readonly secretBox: SecretBox },
) {
  const workspaces = createHostedTaskWorkspaces(input)
  return {
    workspaces,
    reference: hostedWorkspaceReference,
    locate(reference: string, relative?: string) {
      return parseHostedWorkspaceReference(
        relative === undefined ? reference : joinHostedWorkspaceReference(reference, relative),
      )
    },
    bind(
      helper: WorkspaceHelper & {
        recover<T>(taskId: string, operationId: string): Promise<{ value: T } | null>
      },
    ) {
      const workspaceMaintenanceFilesystem = createHostedWorkspaceMaintenance({
        helper,
        workspaces,
        isMaterializingTask: (taskId) => materializingSpaces.has(taskId),
      })
      return {
        ...createHostedWorkspaceEffects({ helper, workspaces, api: input.api }),
        workspacePresence: { exists: workspaceMaintenanceFilesystem.exists },
        workspaceMaintenanceFilesystem,
        isolationWorkspaces: createHostedIsolationWorkspaces(helper),
        repositoryPreparationEffects: createHostedRepositoryPreparation({
          db: input.db,
          secretBox: input.secretBox,
          helper,
          recoverMaterialization: (taskId, operationId) =>
            helper.recover<MaterializedSpace>(taskId, operationId),
        }),
        scratchWorkspaceEffects: createHostedScratchWorkspaces(helper),
      }
    },
  }
}
