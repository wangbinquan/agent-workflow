// RFC-517 — the HTTP stage-restore command releases its ingress artifact after staging, whatever the outcome
// (RFC-294 S10).
import type { StageRestoreCommand } from '../public/commands'
import type { RestoreArtifactRef } from '../public/types'

export function releaseArtifactAfterStageRestore(
  command: StageRestoreCommand,
  artifacts: { release(ref: RestoreArtifactRef): void },
): StageRestoreCommand {
  return Object.freeze({
    async execute(
      context: Parameters<StageRestoreCommand['execute']>[0],
      input: Parameters<StageRestoreCommand['execute']>[1],
    ) {
      try {
        return await command.execute(context, input)
      } finally {
        artifacts.release(input.artifactRef)
      }
    },
  })
}
