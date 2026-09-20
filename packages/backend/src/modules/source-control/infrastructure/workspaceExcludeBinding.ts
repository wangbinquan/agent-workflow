import type { WorkspaceExcludeParticipant } from '../public/participants'
import { ensureWorkspaceExcludeProfile } from './workspaceExcludeManager'

/** RFC-308 temporary composition seam until RFC-294 W5 owns durable WorkspaceRef. */
export function bindWorkspaceExcludeParticipant(input: {
  worktreePath: string
  appHome?: string
}): WorkspaceExcludeParticipant {
  return {
    ensure: (request = {}) =>
      ensureWorkspaceExcludeProfile({
        ...input,
        directChildMounts: request.directChildMounts ?? [],
      }),
  }
}
