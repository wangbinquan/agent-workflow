// RFC-370 A4 — candidate effects are selected only at composition.
// RFC-370 §9.2 V3 — a hosted selection is an operation host: each whole use
// case runs in the remote volume instead of one round trip per step.
// RFC-527 — the selection is required: standalone selects the local step factory below, which carries the local
// fixture session its pushes use (no hosted transport or durable subject: local paths and `file://` remotes).
// RFC-622: the two participants that drive the selection moved to `application/repositoryCandidateParticipants.ts`.
import type { RepositoryCandidateStepEffectsFactory } from '../application/ports/repositoryCandidateEffects'
import type { RepositoryGit } from '../application/repositoryCommit'
import { createFileRepositoryCandidateEffectsFactory } from '../infrastructure/local/fileRepositoryCandidateEffects'
import { createFileRepositoryPublicationFixtureSession } from '../infrastructure/local/fileRepositoryPublicationFixture'

/** RFC-527: the standalone selection — local candidate steps whose pushes open the local fixture session. */
export function createLocalRepositoryCandidateEffects(
  input: { readonly runGit?: RepositoryGit } = {},
): RepositoryCandidateStepEffectsFactory {
  const runGit = input.runGit
  return Object.freeze({
    ...createFileRepositoryCandidateEffectsFactory({ runGit }),
    localFixtureSession: (remoteUrl: string) =>
      createFileRepositoryPublicationFixtureSession(remoteUrl, runGit),
  })
}
