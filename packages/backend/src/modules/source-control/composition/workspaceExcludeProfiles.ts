import type {
  WorkspaceExcludeParticipant,
  WorkspaceExcludeProfileFactory,
} from '../public/participants'
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
  if (factory === null || typeof factory !== 'object' || typeof factory.bind !== 'function') {
    throw new TypeError('Workspace exclude requires a complete profile factory')
  }
  return factory
}

export function bindWorkspaceExcludeProfile(
  factory: WorkspaceExcludeProfileFactory,
  input: { readonly workspaceRef: string },
): WorkspaceExcludeParticipant {
  const participant = factory.bind(input)
  if (
    participant === null ||
    typeof participant !== 'object' ||
    typeof participant.ensure !== 'function'
  ) {
    throw new TypeError('Workspace exclude requires a complete profile participant')
  }
  return participant
}
