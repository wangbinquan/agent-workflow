// RFC-370 — Intent apply over the hosted Resource Catalog artifact owners.
// Assembly only: the retention read lives in Intent infrastructure, and the
// resource owners arrive through Resource Catalog's public participant.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { HostedIntentResourceArtifacts } from '@/modules/resource-catalog/public/participants'
import { createHostedIntentPluginRetention } from '../infrastructure/crewstation/pluginRetention'
import { createHostedIntentArtifactContent } from '../infrastructure/crewstation/intentArtifactContent'
import type { IntentArtifactSelection } from './apply'

export function composeCrewStationIntentPluginRetention(db: PersistenceDb) {
  return createHostedIntentPluginRetention(db)
}

export function composeCrewStationIntentArtifacts(
  resources: HostedIntentResourceArtifacts,
): IntentArtifactSelection {
  return {
    pluginArtifacts: resources.pluginArtifacts,
    skillArtifacts: resources.skillArtifacts,
    artifactContent: createHostedIntentArtifactContent(resources),
  }
}
