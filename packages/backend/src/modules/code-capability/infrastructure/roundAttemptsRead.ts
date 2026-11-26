// RFC-602: online queries use the explicitly prepared durable projection.
import type { CodeHistoryQueryReader } from '../application/ports/historyQueryIndex'
import type { RoundAttemptsReadPort } from '../application/ports/roundAttemptsRead'

export function createRoundAttemptsRead(history: CodeHistoryQueryReader): RoundAttemptsReadPort {
  return history.attempts
}
