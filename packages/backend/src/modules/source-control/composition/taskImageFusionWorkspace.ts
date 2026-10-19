// RFC-370 §10 V20 — task-image entry of `fusion-workspace`. Runs only in the CS
// task image: one command seeds or collects a fusion engine task's working copy
// inside that task's own volume, with the standalone Source Control steps.
import { runFusionWorkspaceVolumeOperation } from '../infrastructure/crewstation/fusionWorkspaceVolume'

export { FUSION_WORKSPACE_OPERATION } from '../infrastructure/crewstation/fusionWorkspaceVolume'

export function executeTaskImageFusionWorkspace(value: unknown, volumeRoot: string) {
  return runFusionWorkspaceVolumeOperation(value, volumeRoot)
}
