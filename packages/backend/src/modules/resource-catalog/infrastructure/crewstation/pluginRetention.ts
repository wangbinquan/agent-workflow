// RFC-370 — plugin generations that an unfinished resource package apply still
// names are retained by the generation GC. Read inside the caller's transaction
// when one is given.
import { inArray } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { resourceBundleApplies } from '@/db/schema'
import { decodeResourcePackageArtifacts } from '../postgresqlResourcePackageMaintenance'

export function createHostedResourcePackagePluginRetention(db: ProviderNeutralDatabase) {
  return async (reader: ProviderNeutralDatabase = db): Promise<readonly string[]> => {
    const journals = await reader
      .select({ json: resourceBundleApplies.preparedArtifactsJson })
      .from(resourceBundleApplies)
      .where(inArray(resourceBundleApplies.state, ['prepared', 'applying']))
    const retained: string[] = []
    for (const journal of journals)
      for (const artifact of decodeResourcePackageArtifacts(journal.json))
        if (artifact.kind === 'plugin-install') retained.push(artifact.generationDirectory)
    return retained
  }
}
