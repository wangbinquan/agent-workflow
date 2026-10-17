// RFC-370 — plugin generations an unfinished Intent apply journal still names
// are retained by the hosted plugin generation GC. Read inside the caller's
// transaction when one is given.
import { inArray } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { intentApplyJournal } from '@/db/schema'
import { decodeIntentApplyRecoveryArtifacts } from '../intentApplyArtifactLifecycle'

export function createHostedIntentPluginRetention(db: ProviderNeutralDatabase) {
  return async (reader: ProviderNeutralDatabase = db): Promise<readonly string[]> => {
    const rows = await reader
      .select({ json: intentApplyJournal.preparedArtifactsJson })
      .from(intentApplyJournal)
      .where(inArray(intentApplyJournal.state, ['prepared', 'applying']))
    const retained: string[] = []
    for (const row of rows)
      for (const artifact of decodeIntentApplyRecoveryArtifacts(row.json)) {
        if (artifact.kind === 'plugin-install' && 'generationDir' in artifact)
          retained.push(artifact.generationDir)
      }
    return retained
  }
}
