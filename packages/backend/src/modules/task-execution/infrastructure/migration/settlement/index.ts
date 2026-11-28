import type { SettlementContribution } from '@/platform/persistence/migration/conversion/rule'
import { cascadeSettlements } from './cascade'
import { executionIntentSettler } from './executionIntents'
import { executionOwnerSettler } from './executionOwners'
import { nodeRunSettler } from './nodeRuns'
import { taskRowSettler } from './tasks'

/**
 * RFC-626 §3.2.3: what ending a task as canceled writes to the task-execution rows (table rows
 * 1–5), and which further tasks it ends. The engine calls these on the staged decoded values;
 * the source evidence of every row stays as the previous release wrote it.
 */
export const taskSettlement: SettlementContribution = {
  settlers: [taskRowSettler, nodeRunSettler, executionIntentSettler, executionOwnerSettler],
  expand: cascadeSettlements,
}
