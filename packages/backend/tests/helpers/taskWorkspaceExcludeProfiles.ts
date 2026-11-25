// RFC-527: the per-drive exclude-profile selection only tests used, moved out of production
// (modules/task-execution/composition/localTaskRunSelection.ts). A given selection is used for every drive;
// without one, each drive gets the local profile that reads its configuration under the request's application home (else
// `Paths.root`) at each binding — what the retired fallback of the source-control selection built.
import { bindWorkspaceExcludeParticipant } from '@/modules/source-control/composition'
import type { WorkspaceExcludeProfileFactory } from '@/modules/source-control/public/participants'
import type { TaskDriveRequest } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import { Paths } from '@/platform/configuration/installationPaths'

export function composeTaskWorkspaceExcludeProfilesFor(
  selected?: WorkspaceExcludeProfileFactory,
): (request: Pick<TaskDriveRequest, 'appHome'>) => WorkspaceExcludeProfileFactory {
  if (selected !== undefined) return () => selected
  return (request) =>
    Object.freeze<WorkspaceExcludeProfileFactory>({
      bind(input) {
        return bindWorkspaceExcludeParticipant({
          worktreePath: input.workspaceRef,
          appHome: request.appHome ?? Paths.root,
        })
      },
    })
}
