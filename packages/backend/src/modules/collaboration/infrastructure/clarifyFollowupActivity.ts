import { ConflictError } from '@/util/errors'
import type {
  ClarifyFollowupActivity,
  ClarifyFollowupInFlight,
} from '../application/ports/clarifyFollowup'

// Native generators are process-owned and abort with this process. The round
// seal reads this same registry, so it owns no answers and keeps one entry per round.
const active = new Map<string, ClarifyFollowupInFlight>()

export const clarifyFollowupActivity: ClarifyFollowupActivity = Object.freeze({
  current: (nodeRunId: string) => active.get(nodeRunId),
  begin(nodeRunId: string, inFlight: ClarifyFollowupInFlight) {
    if (active.has(nodeRunId))
      throw new ConflictError(
        'clarify-followup-busy',
        'A follow-up is already being generated for this round.',
      )
    active.set(nodeRunId, inFlight)
    return () => {
      if (active.get(nodeRunId) === inFlight) active.delete(nodeRunId)
    }
  },
})

/** A canceled generation no longer blocks submission while it settles. */
export function assertClarifyFollowupIdle(nodeRunId: string): void {
  const inFlight = active.get(nodeRunId)
  if (inFlight && !inFlight.abort.signal.aborted)
    throw new ConflictError(
      'clarify-followup-busy',
      'A follow-up is being generated. Wait for it or cancel it before submitting.',
    )
}
