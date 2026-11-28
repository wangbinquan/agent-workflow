import type { TaskSettler } from '@/platform/persistence/migration/conversion/rule'
import type { EncodedKey, SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import { clarifyRoundTransition } from '../../domain/clarifyAnswers'

/**
 * RFC-626 §3.2.3 row 6: ending a task closes its open clarify rounds the way the terminal
 * sweep does when a task is canceled (`infrastructure/humanGateTerminalSweep.ts`): a cross
 * round is abandoned at the upgrade time, every other round is canceled. The column values
 * come from the domain transition the sweep writes, so the two cannot drift apart. Rounds
 * that are not awaiting a human, and rows the frozen codec could not decode, stay as they are.
 */
export function settleClarifyRounds(
  rounds: readonly SourceRow[],
  planTime: number,
): readonly {
  readonly table: string
  readonly key: EncodedKey
  readonly values: DecodedSourceRow
}[] {
  return rounds.flatMap((round) => {
    if (round.codecFailure || round.values.status !== 'awaiting_human') return []
    const transition = clarifyRoundTransition(
      round.values.kind === 'cross' ? 'abandon' : 'cancel',
      planTime,
    )
    return [
      {
        table: 'clarify_rounds',
        key: round.encodedKey,
        values: {
          ...round.values,
          status: transition.status,
          ...('abandonedAt' in transition ? { abandoned_at: transition.abandonedAt } : {}),
        },
      },
    ]
  })
}

export const clarifyRoundSettler: TaskSettler = {
  tables: [{ table: 'clarify_rounds', taskColumn: 'task_id' }],
  settle: (rows, ctx) => settleClarifyRounds(rows.get('clarify_rounds') ?? [], ctx.planTime),
}
