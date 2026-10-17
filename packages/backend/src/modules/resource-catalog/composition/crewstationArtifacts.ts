// RFC-370 — the hosted Resource Catalog artifact store selection, shared by
// HTTP, Intent and maintenance. Assembly only.
import type { HostedIntentResourceArtifacts } from '../public/participants'
import { createHostedPluginGenerations } from '../infrastructure/crewstation/pluginGenerations'
import { createHostedPluginArtifactOwners } from '../infrastructure/crewstation/pluginArtifacts'
import { createHostedResourcePackagePluginRetention } from '../infrastructure/crewstation/pluginRetention'
import { createDatabaseSkillArtifactOwners } from '../infrastructure/crewstation/skillArtifacts'
import {
  decodeResourcePackageArtifacts,
  decodeResourcePackageReceipt,
  assertResourcePackageArtifactReceipt,
} from '../infrastructure/postgresqlResourcePackageMaintenance'
import type { ResourcePackageApplyArtifactRecoveryPort } from '../application/resourcePackageMaintenance'

export function composeCrewStationResourceArtifacts(
  input: Parameters<typeof createHostedPluginGenerations>[0],
) {
  const packageRetention = createHostedResourcePackagePluginRetention(input.db)
  const generations = createHostedPluginGenerations({
    ...input,
    async retainedReferences(db = input.db) {
      return [...(await input.retainedReferences(db)), ...(await packageRetention(db))]
    },
  })
  const skills = createDatabaseSkillArtifactOwners(input.db, input.fence)
  const plugins = createHostedPluginArtifactOwners({ db: input.db, generations })
  const resourcePackageRecovery: ResourcePackageApplyArtifactRecoveryPort = {
    async rollForward(journal) {
      const receipt = decodeResourcePackageReceipt(journal)
      for (const artifact of decodeResourcePackageArtifacts(journal.preparedArtifactsJson)) {
        assertResourcePackageArtifactReceipt(receipt, artifact)
        if (artifact.kind === 'plugin-install') {
          plugins.recovery.assertReference(artifact)
          await plugins.recovery.verifyCurrent(artifact.pluginId, true)
        } else await skills.recovery.publishArtifact(artifact)
      }
    },
    async compensate(journal) {
      for (const artifact of [
        ...decodeResourcePackageArtifacts(journal.preparedArtifactsJson),
      ].reverse()) {
        if (artifact.kind === 'plugin-install') {
          plugins.recovery.assertReference(artifact)
          await generations.discard(artifact.generationDirectory)
        } else await skills.recovery.discardArtifact(artifact)
      }
    },
  }
  const intent: HostedIntentResourceArtifacts = {
    pluginArtifacts: plugins.intent,
    skillArtifacts: skills.intent,
    async pluginExists(reference) {
      await generations.read(reference)
      return true
    },
    discardPlugin: (reference) => generations.discard(reference),
    stageSkillReference: (identity) => skills.recovery.stageReference(identity),
    publishSkill: (identity) => skills.recovery.publish(identity),
    discardSkill: (identity) => skills.recovery.discard(identity),
  }
  return {
    generations,
    skills,
    plugins,
    intent,
    selections: {
      pluginInstaller: generations.installer,
      resourcePackageSkillArtifacts: skills.packages,
      resourcePackagePluginArtifacts: plugins.packages,
    },
    maintenance: { resourcePackageRecovery, pluginGenerationGc: generations.gc },
  }
}
