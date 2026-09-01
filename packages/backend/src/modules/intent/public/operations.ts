import type { Actor } from '@/auth/actor'

/** Intent owns its audit visibility policy; Resource Catalog has no role in it. */
export function canAuditIntentSessions(actor: Actor): boolean {
  return actor.permissions.has('intent:audit')
}

export type {
  IntentPersistence,
  IntentDraftRecord,
  IntentDraftResolutionRecord,
  IntentApplyJournalRecord,
  IntentContextResourceAuthorization,
  IntentContextResourceAuthorityPair,
  IntentResourceVisibility,
  IntentSessionListRecord,
  IntentSessionRecord,
  IntentTurnEventRecord,
  IntentTurnRecord,
  IntentWorkingSetChangeRecord,
  ReservedIntentTurnRecord,
} from '../application/ports/intentPersistence'
export type {
  IntentApplyInput,
  IntentApplyDecision,
  IntentApplyOperations,
  IntentApplyReceipt,
} from '../application/ports/intentApplyOperations'
export type {
  IntentAgentPortNames,
  IntentAuxiliaryPersistence,
  IntentDumpAuxiliaryQueries,
  IntentPlatformInventoryParticipant,
  IntentPlatformInventoryRow,
  IntentResolvedRuntime,
  IntentRuntimeInventoryRow,
  IntentTurnRuntimeResolver,
} from '../application/ports/intentAuxiliaryQueries'
