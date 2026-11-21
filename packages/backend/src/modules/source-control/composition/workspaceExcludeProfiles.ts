import type {
  WorkspaceExcludeParticipant,
  WorkspaceExcludeProfileFactory,
} from '../public/participants'
import { requireWorkspaceExcludeParticipant } from '../application/workspacePorts'
import { bindWorkspaceExcludeParticipant } from '../infrastructure/workspaceExcludeBinding'

// RFC-527: the exclude-profile selection is gone — its only caller was a task-execution entry only tests used, and the
// deployment's selection reaches the drive whole.

/**
 * RFC-431: the standalone selection — the native profile reads its configuration under the app home, at the original
 * per-repository binding boundary. RFC-527: built here, no longer through the selection's fallback.
 */
export function composeLocalWorkspaceExcludeProfiles(input: {
  readonly appHome: string
}): WorkspaceExcludeProfileFactory {
  return Object.freeze<WorkspaceExcludeProfileFactory>({
    bind(profile) {
      return bindWorkspaceExcludeParticipant({
        worktreePath: profile.workspaceRef,
        appHome: input.appHome,
      })
    },
  })
}

export function bindWorkspaceExcludeProfile(
  factory: WorkspaceExcludeProfileFactory,
  input: { readonly workspaceRef: string },
): WorkspaceExcludeParticipant {
  const participant = factory.bind(input)
  requireWorkspaceExcludeParticipant(participant)
  return participant
}
