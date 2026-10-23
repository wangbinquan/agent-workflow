// RFC-370 — plugin generations that an unfinished resource package apply still
// names are retained by the generation GC. Read inside the caller's transaction
// when one is given.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { inArray } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { decodeResourcePackageArtifacts } from '../postgresqlResourcePackageMaintenance'

export function createHostedResourcePackagePluginRetention(db: PersistenceDb) {
  return async (reader: PersistenceDb = db): Promise<readonly string[]> => {
    const { resourceBundleApplies } = tablesOf(reader)
    const journals = await reader
      .select({ json: resourceBundleApplies.preparedArtifactsJson })
      .from(resourceBundleApplies)
      .where(inArray(resourceBundleApplies.state, ['prepared', 'applying']))
    const retained: string[] = []
    for (const journal of journals)
      for (const artifact of decodeResourcePackageArtifacts(journal.json))
        if (artifact.kind === 'plugin-install')
          retained.push(
            'generationDirectory' in artifact
              ? artifact.generationDirectory
              : artifact.generationDir,
          )
    return retained
  }
}
