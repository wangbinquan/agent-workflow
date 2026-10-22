// RFC-370 — plugin generations an unfinished Intent apply journal still names
// are retained by the hosted plugin generation GC. Read inside the caller's
// transaction when one is given.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { inArray } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { decodeIntentApplyRecoveryArtifacts } from '../intentApplyArtifactLifecycle'

export function createHostedIntentPluginRetention(db: PersistenceDb) {
  return async (reader: PersistenceDb = db): Promise<readonly string[]> => {
    const { intentApplyJournal } = tablesOf(reader)
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
