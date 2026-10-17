import { and, eq, lte } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { intentTurns } from '@/db/schema'
import type { IntentScratchStore } from '../application/ports/intentScratchStore'

/** Intent owns retention and turn identities. The selected execution owner
 * proves quiescence and removes only that turn's remote scratch directory. */
export function composeCrewStationIntentScratchStore(input: {
  readonly db: ProviderNeutralDatabase
  readonly remove: (turnId: string) => Promise<void>
}): IntentScratchStore {
  return {
    async staleTurnIds(cutoff) {
      const rows = await input.db
        .select({ id: intentTurns.id })
        .from(intentTurns)
        .where(and(eq(intentTurns.scratchRetained, true), lte(intentTurns.createdAt, cutoff)))
      return rows.map((row) => row.id).sort()
    },
    async remove(turnId) {
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
