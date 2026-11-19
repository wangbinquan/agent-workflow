import type {
  WorkspaceExcludeParticipant,
  WorkspaceExcludeProfileFactory,
} from '../public/participants'
import {
  requireWorkspaceExcludeParticipant,
  requireWorkspaceExcludeProfileFactory,
} from '../application/workspacePorts'
import { bindWorkspaceExcludeParticipant } from '../infrastructure/workspaceExcludeBinding'

/** Native configuration is read at the original per-repository binding boundary. */
export function selectWorkspaceExcludeProfileFactory(
  selected?: WorkspaceExcludeProfileFactory,
  readLocalAppHome?: () => string,
): WorkspaceExcludeProfileFactory {
  const factory =
    selected === undefined
      ? Object.freeze<WorkspaceExcludeProfileFactory>({
          bind(input) {
            return bindWorkspaceExcludeParticipant({
              worktreePath: input.workspaceRef,
              ...(readLocalAppHome === undefined ? {} : { appHome: readLocalAppHome() }),
            })
          },
        })
      : selected
  requireWorkspaceExcludeProfileFactory(factory)
  return factory
}

/** RFC-431: the standalone selection — the native profile reads its configuration under the app home. */
export function composeLocalWorkspaceExcludeProfiles(input: {
  readonly appHome: string
}): WorkspaceExcludeProfileFactory {
  return selectWorkspaceExcludeProfileFactory(undefined, () => input.appHome)
}

export function bindWorkspaceExcludeProfile(
  factory: WorkspaceExcludeProfileFactory,
  input: { readonly workspaceRef: string },
): WorkspaceExcludeParticipant {
  const participant = factory.bind(input)
  requireWorkspaceExcludeParticipant(participant)
  return participant
}
