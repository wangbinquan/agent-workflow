// RFC-303 bootstrap-owned composition helpers. Integration receives only the
// participant and a mint closure, never task rows or driver internals.
import type { DbClient } from '@/db/client'
import { createTaskSourceTerminationParticipant } from '@/modules/task-execution/application/applySourceTerminationEffect'
import { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'

export function composeTaskSourceTermination(db: DbClient) {
  return {
    participant: createTaskSourceTerminationParticipant(db),
    mintCapability: mintSourceTerminationEffectCapability,
  }
}
