import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, lte } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { IntentScratchStore } from '../application/ports/intentScratchStore'

/** Intent owns retention and turn identities. The selected execution owner
 * proves quiescence and removes only that turn's remote scratch directory. */
export function composeCrewStationIntentScratchStore(input: {
  readonly db: PersistenceDb
  readonly remove: (turnId: string) => Promise<void>
}): IntentScratchStore {
  return {
    async staleTurnIds(cutoff) {
      const { intentTurns } = tablesOf(input.db)
      const rows = await input.db
        .select({ id: intentTurns.id })
        .from(intentTurns)
        .where(and(eq(intentTurns.scratchRetained, true), lte(intentTurns.createdAt, cutoff)))
      return rows.map((row) => row.id).sort()
    },
    async remove(turnId) {
      const { intentTurns } = tablesOf(input.db)
      const turn = (
        await input.db
          .select({ kind: intentTurns.kind })
          .from(intentTurns)
          .where(eq(intentTurns.id, turnId))
          .limit(1)
      )[0]
      if (turn?.kind === 'running') throw new Error('hosted-intent-scratch-turn-running')
      await input.remove(turnId)
    },
  }
}
