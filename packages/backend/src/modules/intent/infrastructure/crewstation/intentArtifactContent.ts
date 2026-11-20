// RFC-519 — the hosted Intent artifact content (RFC-294 S10): skill publication and discard go to the Resource Catalog's hosted
// artifact owners after the staged reference is checked against the one the owner issued; legacy artifacts need a migration.
import type { HostedIntentResourceArtifacts } from '@/modules/resource-catalog/public/participants'
import type {
  IntentArtifactContentPort,
  IntentSkillArtifact,
} from '../../application/ports/intentArtifactContent'

export function createHostedIntentArtifactContent(
  resources: HostedIntentResourceArtifacts,
): IntentArtifactContentPort {
  const identity = (artifact: IntentSkillArtifact, version: number) => {
    const value = { skillId: artifact.skillId, operationId: artifact.operationId, version }
    if (
      version !== (artifact.kind === 'skill-stage' ? 1 : artifact.version) ||
      artifact.stagingDirectory !== resources.stageSkillReference(value)
    )
      throw new Error('hosted-intent-skill-reference-mismatch')
    return value
  }
  return {
    pluginExists: (reference) => resources.pluginExists(reference),
    discardPlugin: (reference) => resources.discardPlugin(reference),
    publishSkill: async (publication) => {
      await resources.publishSkill(identity(publication.artifact, publication.version))
    },
    discardSkill: async (request) => {
      await resources.discardSkill(identity(request.artifact, request.version))
    },
    discardLegacy: () => {
      throw new Error('hosted-intent-legacy-artifact-requires-migration')
    },
  }
}
