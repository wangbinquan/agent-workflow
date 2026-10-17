// RFC-370 — Intent apply over the hosted Resource Catalog artifact owners.
// Assembly only: the retention read lives in Intent infrastructure, and the
// resource owners arrive through Resource Catalog's public participant.
import type { ProviderNeutralDatabase } from '@/db/query'
import type { HostedIntentResourceArtifacts } from '@/modules/resource-catalog/public/participants'
import { createHostedIntentPluginRetention } from '../infrastructure/crewstation/pluginRetention'
import type { IntentArtifactSelection } from './apply'
import type { IntentSkillArtifact } from '../application/ports/intentArtifactContent'

export function composeCrewStationIntentPluginRetention(db: ProviderNeutralDatabase) {
  return createHostedIntentPluginRetention(db)
}

export function composeCrewStationIntentArtifacts(
  resources: HostedIntentResourceArtifacts,
): IntentArtifactSelection {
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
    pluginArtifacts: resources.pluginArtifacts,
    skillArtifacts: resources.skillArtifacts,
    artifactContent: {
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
    },
  }
}
