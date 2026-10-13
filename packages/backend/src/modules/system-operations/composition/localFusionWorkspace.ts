// Bootstrap-only cross-context assembly. The native workspace adapter never
// selects another module's private implementation from its application layer.
import { createLocalFusionWorkspaceFactory } from '@/modules/knowledge-evolution/infrastructure/local/fusionWorkspace'
import {
  bindWorkspaceExcludeParticipant,
  ensureBoundPlatformWorkspaceDirectory,
} from '@/modules/source-control/composition'

export function composeLocalFusionWorkspaces() {
  return createLocalFusionWorkspaceFactory({
    async ensureExcludes({ workspaceRef, appHome }) {
      await bindWorkspaceExcludeParticipant({ worktreePath: workspaceRef, appHome }).ensure()
    },
    ensurePlatformDirectory(workspaceRef) {
      ensureBoundPlatformWorkspaceDirectory({ worktreePath: workspaceRef, kind: 'fusion' })
    },
  })
}
