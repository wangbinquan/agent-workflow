// RFC-395 II-b O3 — all business retention statements are supplied by their owners.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { RetentionSweepPhase } from '@/platform/background/retentionSweepPhase'
import { createDistillEventRetentionPhase } from '@/modules/memory/composition'
import { createIntentTurnEventRetentionPhase } from '@/modules/intent/composition'
import { createMcpRuntimeTestEventRetentionPhase } from '@/modules/resource-catalog/composition'
import { createWebhookFireRetentionPhase } from '@/modules/integration/composition'
import { nonTerminalTaskExists } from '@/modules/task-execution/composition'

export function composeRetentionSweepPhases(db: PersistenceDb): readonly RetentionSweepPhase[] {
  return [
    createDistillEventRetentionPhase(db),
    createIntentTurnEventRetentionPhase(db),
    createMcpRuntimeTestEventRetentionPhase(db),
    // RFC-565: the webhook fire candidates keep Task Execution's non-terminal task fragment in the same statement.
    createWebhookFireRetentionPhase(db, nonTerminalTaskExists),
  ]
}
